"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { validarCredencialGa4 } from "@/lib/plataformas-de-anuncio/ga4/validar-credencial";

export type UpdateTrackingGa4Result =
  | { ok: true }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden_tenant"
        | "forbidden_role"
        | "mfa_required"
        | "credencial_invalida"
        | "cifra_indisponivel"
        | "erro_ao_gravar";
      details?: unknown;
    };

const entradaSchema = z.object({
  measurement_id: z.string().trim().regex(/^G-[A-Z0-9]+$/, "formato G-XXXXXXX"),
  api_secret: z.string().trim().min(10).max(200).optional(),
  enabled: z.boolean(),
});

export type UpdateTrackingGa4Input = z.infer<typeof entradaSchema>;

export async function updateTrackingGa4(input: UpdateTrackingGa4Input): Promise<UpdateTrackingGa4Result> {
  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation_failed", details: parsed.error.flatten() };

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden_role" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!authUser.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return { ok: false, error: "forbidden_role" };
  }
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const admin = createAdminClient();

  let apiSecret = parsed.data.api_secret ?? null;
  if (!apiSecret) {
    const { data: existente } = await admin
      .from("integration_settings")
      .select("secrets_encrypted")
      .eq("organization_id", activeOrg.orgId)
      .eq("provider", "GA4")
      .maybeSingle();
    const encrypted = (existente as { secrets_encrypted: string | null } | null)?.secrets_encrypted;
    if (encrypted) {
      const cru = await decryptWebhookSecret(admin, encrypted);
      if (cru) {
        try {
          apiSecret = (JSON.parse(cru) as { api_secret?: string }).api_secret ?? null;
        } catch {
          apiSecret = null;
        }
      }
    }
  }
  if (!apiSecret) return { ok: false, error: "validation_failed", details: "api_secret obrigatório na primeira conexão" };

  const validacao = await validarCredencialGa4(parsed.data.measurement_id, apiSecret);
  if (!validacao.ok) return { ok: false, error: "credencial_invalida", details: validacao.motivo };

  const cifrado = await encryptWebhookSecret(admin, JSON.stringify({ api_secret: apiSecret }));
  if (!cifrado) return { ok: false, error: "cifra_indisponivel" };

  const { error } = await admin.from("integration_settings").upsert(
    {
      organization_id: activeOrg.orgId,
      provider: "GA4",
      enabled: parsed.data.enabled,
      config: { measurement_id: parsed.data.measurement_id },
      secrets_encrypted: cifrado,
      updated_by: authUser.id,
    },
    { onConflict: "organization_id,provider" },
  );
  if (error) return { ok: false, error: "erro_ao_gravar", details: error.message };

  const hdrs = await headers();
  await audit({
    action: "tracking_integration.ga4.updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "integration_settings",
    resourceId: null,
    requestId: hdrs.get("x-request-id") ?? undefined,
    metadata: {
      enabled: parsed.data.enabled,
      measurement_id: parsed.data.measurement_id,
      segredo_trocado: Boolean(parsed.data.api_secret),
    },
  });

  revalidatePath("/app/integrations/rastreamento");
  return { ok: true };
}
