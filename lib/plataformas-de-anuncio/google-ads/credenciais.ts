import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { logger } from "@/lib/logger";
import type { NomeDoEvento } from "../types";

/**
 * Google Ads não tem vocabulário fixo de evento como a Meta (item 6 do
 * pedido) — cada evento interno mapeia pra uma Conversion Action ID que o
 * cliente configura na tela. `conversionActionMap` é esse mapa, guardado em
 * `config` (não é segredo: é só um ID de recurso da conta do cliente).
 *
 * Chaveado por `NomeDoEvento` (o vocabulário que o transporte já recebe em
 * `ConversaoOffline.evento` — "Lead"/"Qualified"/"Purchase") e não pelo tipo
 * interno de `lib/rastreamento/motor/`, pra não precisar de uma tradução a
 * mais dentro do transporte.
 */
export interface CredencialGoogleAds {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  customerId: string;
  loginCustomerId: string | null;
  conversionActionMap: Partial<Record<NomeDoEvento, string>>;
}

export type MotivoSemCredencialGoogleAds =
  | "sem_conexao"
  | "conexao_desabilitada"
  | "credencial_incompleta"
  | "cifra_indisponivel";

export type LeituraDeCredencialGoogleAds =
  | { ok: true; credencial: CredencialGoogleAds }
  | { ok: false; motivo: MotivoSemCredencialGoogleAds };

export async function lerCredencialGoogleAds(
  admin: SupabaseClient,
  organizationId: string,
): Promise<LeituraDeCredencialGoogleAds> {
  const { data, error } = await admin
    .from("integration_settings")
    .select("config, secrets_encrypted, enabled")
    .eq("organization_id", organizationId)
    .eq("provider", "GOOGLE_ADS")
    .maybeSingle();

  if (error) {
    logger.error("[rastreamento.google_ads.credencial] leitura falhou", {
      organizationId,
      error: error.message,
    });
    return { ok: false, motivo: "sem_conexao" };
  }
  if (!data) return { ok: false, motivo: "sem_conexao" };

  const linha = data as {
    config: Record<string, unknown> | null;
    secrets_encrypted: string | null;
    enabled: boolean;
  };

  if (!linha.enabled) return { ok: false, motivo: "conexao_desabilitada" };

  const config = linha.config ?? {};
  const customerId = typeof config.customer_id === "string" ? config.customer_id.trim() : "";
  const loginCustomerId =
    typeof config.login_customer_id === "string" ? config.login_customer_id.trim() : null;
  const conversionActionMap =
    (config.conversion_action_map as Partial<Record<NomeDoEvento, string>> | undefined) ?? {};

  if (!customerId || !linha.secrets_encrypted) {
    return { ok: false, motivo: "credencial_incompleta" };
  }

  const segredosCrus = await decryptWebhookSecret(
    admin,
    linha.secrets_encrypted as unknown as string,
  );
  if (segredosCrus === null) return { ok: false, motivo: "cifra_indisponivel" };

  let segredos: {
    developer_token?: string;
    client_id?: string;
    client_secret?: string;
    refresh_token?: string;
  };
  try {
    segredos = JSON.parse(segredosCrus) as typeof segredos;
  } catch {
    return { ok: false, motivo: "credencial_incompleta" };
  }
  if (
    !segredos.developer_token ||
    !segredos.client_id ||
    !segredos.client_secret ||
    !segredos.refresh_token
  ) {
    return { ok: false, motivo: "credencial_incompleta" };
  }

  return {
    ok: true,
    credencial: {
      developerToken: segredos.developer_token,
      clientId: segredos.client_id,
      clientSecret: segredos.client_secret,
      refreshToken: segredos.refresh_token,
      customerId,
      loginCustomerId,
      conversionActionMap,
    },
  };
}
