"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { validarCredencialMeta } from "@/lib/plataformas-de-anuncio/meta/validar-credencial-rastreamento";

/**
 * Conecta o Meta Pixel + Conversions API do motor de rastreamento
 * first-party — irmão de `updateAdPlatformConnection.ts` (o do pipeline
 * legado de Purchase-on-won via CTWA), gravando na tabela nova
 * (`integration_settings`, provider META) em vez de `ad_platform_connections`.
 *
 * Testa CONTRA A GRAPH API DE VERDADE antes de gravar (item 7 do pedido) —
 * mesmo padrão síncrono de `app/api/v1/channels/official/route.ts`: o botão
 * de salvar JÁ É o teste de conexão, não um "ping" à parte que pode mentir.
 */
export type UpdateTrackingMetaResult =
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
  pixel_id: z.string().trim().min(5).max(64).regex(/^\d+$/, "só dígitos"),
  access_token: z.string().trim().min(20).max(2000).optional(),
  test_event_code: z.string().trim().max(64).nullable().optional(),
  enabled: z.boolean(),
});

export type UpdateTrackingMetaInput = z.infer<typeof entradaSchema>;

export async function updateTrackingMeta(
  input: UpdateTrackingMetaInput,
): Promise<UpdateTrackingMetaResult> {
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

  // Precisa do token pra testar — se não veio um novo, decifra o que já
  // está gravado (senão salvar só o pixel_id de novo exigiria colar o token
  // toda vez, e a tela nunca mostra o token de volta).
  let tokenParaTestar = parsed.data.access_token ?? null;
  if (!tokenParaTestar) {
    const { data: existente } = await admin
      .from("integration_settings")
      .select("secrets_encrypted")
      .eq("organization_id", activeOrg.orgId)
      .eq("provider", "META")
      .maybeSingle();
    const encrypted = (existente as { secrets_encrypted: string | null } | null)?.secrets_encrypted;
    if (encrypted) {
      const { decryptWebhookSecret } = await import("@/lib/webhooks/secrets");
      const cru = await decryptWebhookSecret(admin, encrypted);
      if (cru) {
        try {
          tokenParaTestar = (JSON.parse(cru) as { access_token?: string }).access_token ?? null;
        } catch {
          tokenParaTestar = null;
        }
      }
    }
  }
  if (!tokenParaTestar) return { ok: false, error: "validation_failed", details: "access_token obrigatório na primeira conexão" };

  const validacao = await validarCredencialMeta(parsed.data.pixel_id, tokenParaTestar);
  if (!validacao.ok) return { ok: false, error: "credencial_invalida", details: validacao.motivo };

  const cifrado = await encryptWebhookSecret(admin, JSON.stringify({ access_token: tokenParaTestar }));
  if (!cifrado) return { ok: false, error: "cifra_indisponivel" };

  const { error } = await admin.from("integration_settings").upsert(
    {
      organization_id: activeOrg.orgId,
      provider: "META",
      enabled: parsed.data.enabled,
      config: { pixel_id: parsed.data.pixel_id },
      secrets_encrypted: cifrado,
      test_event_code: parsed.data.test_event_code?.trim() || null,
      updated_by: authUser.id,
    },
    { onConflict: "organization_id,provider" },
  );
  if (error) return { ok: false, error: "erro_ao_gravar", details: error.message };

  const hdrs = await headers();
  await audit({
    action: "tracking_integration.meta.updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "integration_settings",
    resourceId: null,
    requestId: hdrs.get("x-request-id") ?? undefined,
    metadata: { enabled: parsed.data.enabled, pixel_id: parsed.data.pixel_id, token_trocado: Boolean(parsed.data.access_token) },
  });

  revalidatePath("/app/integrations/rastreamento");
  return { ok: true };
}
