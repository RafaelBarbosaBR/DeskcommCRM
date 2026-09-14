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
import { validarCredencialGoogleAds } from "@/lib/plataformas-de-anuncio/google-ads/validar-credencial";

export type UpdateTrackingGoogleAdsResult =
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

/**
 * `conversion_action_map`: cada evento interno (Lead/Qualified/Purchase)
 * mapeia pra uma Conversion Action ID configurável — item 6 do pedido
 * ("o Google Ads não tem vocabulário padrão fixo como a Meta"). As duas
 * chaves `aw_*` são só pro gtag client-side do CONTACT (item 6: "dispara
 * conversão client-side via gtag se houver AW-ID configurado").
 */
const entradaSchema = z.object({
  customer_id: z.string().trim().regex(/^\d{3}-?\d{3}-?\d{4}$/, "formato XXX-XXX-XXXX"),
  login_customer_id: z.string().trim().regex(/^\d{3}-?\d{3}-?\d{4}$/).nullable().optional(),
  aw_conversion_id: z.string().trim().regex(/^AW-\d+$/, "formato AW-XXXXXXXXX").nullable().optional(),
  aw_contact_label: z.string().trim().max(64).nullable().optional(),
  conversion_action_lead: z.string().trim().max(200).nullable().optional(),
  conversion_action_qualified: z.string().trim().max(200).nullable().optional(),
  conversion_action_purchase: z.string().trim().max(200).nullable().optional(),
  developer_token: z.string().trim().min(10).max(200).optional(),
  client_id: z.string().trim().min(10).max(300).optional(),
  client_secret: z.string().trim().min(10).max(200).optional(),
  refresh_token: z.string().trim().min(10).max(500).optional(),
  enabled: z.boolean(),
});

export type UpdateTrackingGoogleAdsInput = z.infer<typeof entradaSchema>;

interface SegredosGoogleAds {
  developer_token?: string;
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
}

export async function updateTrackingGoogleAds(
  input: UpdateTrackingGoogleAdsInput,
): Promise<UpdateTrackingGoogleAdsResult> {
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

  const { data: existente } = await admin
    .from("integration_settings")
    .select("secrets_encrypted")
    .eq("organization_id", activeOrg.orgId)
    .eq("provider", "GOOGLE_ADS")
    .maybeSingle();
  const encrypted = (existente as { secrets_encrypted: string | null } | null)?.secrets_encrypted;
  let segredosAtuais: SegredosGoogleAds = {};
  if (encrypted) {
    const cru = await decryptWebhookSecret(admin, encrypted);
    if (cru) {
      try {
        segredosAtuais = JSON.parse(cru) as SegredosGoogleAds;
      } catch {
        segredosAtuais = {};
      }
    }
  }

  const segredosNovos: SegredosGoogleAds = {
    developer_token: parsed.data.developer_token ?? segredosAtuais.developer_token,
    client_id: parsed.data.client_id ?? segredosAtuais.client_id,
    client_secret: parsed.data.client_secret ?? segredosAtuais.client_secret,
    refresh_token: parsed.data.refresh_token ?? segredosAtuais.refresh_token,
  };
  if (
    !segredosNovos.developer_token ||
    !segredosNovos.client_id ||
    !segredosNovos.client_secret ||
    !segredosNovos.refresh_token
  ) {
    return {
      ok: false,
      error: "validation_failed",
      details: "developer_token, client_id, client_secret e refresh_token são obrigatórios na primeira conexão",
    };
  }

  const validacao = await validarCredencialGoogleAds({
    clientId: segredosNovos.client_id,
    clientSecret: segredosNovos.client_secret,
    refreshToken: segredosNovos.refresh_token,
    developerToken: segredosNovos.developer_token,
  });
  if (!validacao.ok) return { ok: false, error: "credencial_invalida", details: validacao.motivo };

  const cifrado = await encryptWebhookSecret(admin, JSON.stringify(segredosNovos));
  if (!cifrado) return { ok: false, error: "cifra_indisponivel" };

  const conversionActionMap: Record<string, string> = {};
  if (parsed.data.conversion_action_lead) conversionActionMap.Lead = parsed.data.conversion_action_lead;
  if (parsed.data.conversion_action_qualified) conversionActionMap.Qualified = parsed.data.conversion_action_qualified;
  if (parsed.data.conversion_action_purchase) conversionActionMap.Purchase = parsed.data.conversion_action_purchase;

  const { error } = await admin.from("integration_settings").upsert(
    {
      organization_id: activeOrg.orgId,
      provider: "GOOGLE_ADS",
      enabled: parsed.data.enabled,
      config: {
        customer_id: parsed.data.customer_id.replace(/-/g, ""),
        login_customer_id: parsed.data.login_customer_id?.replace(/-/g, "") || null,
        aw_conversion_id: parsed.data.aw_conversion_id || null,
        aw_contact_label: parsed.data.aw_contact_label || null,
        conversion_action_map: conversionActionMap,
      },
      secrets_encrypted: cifrado,
      updated_by: authUser.id,
    },
    { onConflict: "organization_id,provider" },
  );
  if (error) return { ok: false, error: "erro_ao_gravar", details: error.message };

  const hdrs = await headers();
  await audit({
    action: "tracking_integration.google_ads.updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "integration_settings",
    resourceId: null,
    requestId: hdrs.get("x-request-id") ?? undefined,
    metadata: {
      enabled: parsed.data.enabled,
      customer_id: parsed.data.customer_id,
      segredos_trocados: Boolean(
        parsed.data.developer_token || parsed.data.client_id || parsed.data.client_secret || parsed.data.refresh_token,
      ),
    },
  });

  revalidatePath("/app/integrations/rastreamento");
  return { ok: true };
}
