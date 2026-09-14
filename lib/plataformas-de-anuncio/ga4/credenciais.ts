import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { logger } from "@/lib/logger";

export interface CredencialGa4 {
  measurementId: string;
  apiSecret: string;
}

export type MotivoSemCredencialGa4 =
  | "sem_conexao"
  | "conexao_desabilitada"
  | "credencial_incompleta"
  | "cifra_indisponivel";

export type LeituraDeCredencialGa4 =
  | { ok: true; credencial: CredencialGa4 }
  | { ok: false; motivo: MotivoSemCredencialGa4 };

export async function lerCredencialGa4(
  admin: SupabaseClient,
  organizationId: string,
): Promise<LeituraDeCredencialGa4> {
  const { data, error } = await admin
    .from("integration_settings")
    .select("config, secrets_encrypted, enabled")
    .eq("organization_id", organizationId)
    .eq("provider", "GA4")
    .maybeSingle();

  if (error) {
    logger.error("[rastreamento.ga4.credencial] leitura falhou", {
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

  const measurementId =
    typeof linha.config?.measurement_id === "string" ? linha.config.measurement_id.trim() : "";
  if (!measurementId || !linha.secrets_encrypted) {
    return { ok: false, motivo: "credencial_incompleta" };
  }

  const segredosCrus = await decryptWebhookSecret(
    admin,
    linha.secrets_encrypted as unknown as string,
  );
  if (segredosCrus === null) return { ok: false, motivo: "cifra_indisponivel" };

  let segredos: { api_secret?: string };
  try {
    segredos = JSON.parse(segredosCrus) as { api_secret?: string };
  } catch {
    return { ok: false, motivo: "credencial_incompleta" };
  }
  if (!segredos.api_secret) return { ok: false, motivo: "credencial_incompleta" };

  return { ok: true, credencial: { measurementId, apiSecret: segredos.api_secret } };
}
