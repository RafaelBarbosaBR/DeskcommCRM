import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { logger } from "@/lib/logger";

/**
 * Leitor de credencial do Meta pro motor de rastreamento first-party —
 * irmão de `../credenciais.ts` (o do pipeline legado Purchase-on-won via
 * CTWA), deliberadamente separado: lê `integration_settings` (a tabela nova,
 * por evento×provider) em vez de `ad_platform_connections` (a tabela do
 * pipeline antigo, Purchase-only). Ver decisão 2 do plano — os dois eixos
 * não compartilham tabela de credencial nem de despacho, pra nunca reportar
 * a mesma venda duas vezes.
 */
export interface CredencialMetaRastreamento {
  pixelId: string;
  accessToken: string;
  testEventCode: string | null;
}

export type MotivoSemCredencialMeta =
  | "sem_conexao"
  | "conexao_desabilitada"
  | "credencial_incompleta"
  | "cifra_indisponivel";

export type LeituraDeCredencialMeta =
  | { ok: true; credencial: CredencialMetaRastreamento }
  | { ok: false; motivo: MotivoSemCredencialMeta };

export async function lerCredencialMeta(
  admin: SupabaseClient,
  organizationId: string,
): Promise<LeituraDeCredencialMeta> {
  const { data, error } = await admin
    .from("integration_settings")
    .select("config, secrets_encrypted, test_event_code, enabled")
    .eq("organization_id", organizationId)
    .eq("provider", "META")
    .maybeSingle();

  if (error) {
    logger.error("[rastreamento.meta.credencial] leitura falhou", {
      organizationId,
      error: error.message,
    });
    return { ok: false, motivo: "sem_conexao" };
  }
  if (!data) return { ok: false, motivo: "sem_conexao" };

  const linha = data as {
    config: Record<string, unknown> | null;
    secrets_encrypted: string | null;
    test_event_code: string | null;
    enabled: boolean;
  };

  if (!linha.enabled) return { ok: false, motivo: "conexao_desabilitada" };

  const pixelId =
    typeof linha.config?.pixel_id === "string" ? linha.config.pixel_id.trim() : "";
  if (!pixelId || !linha.secrets_encrypted) {
    return { ok: false, motivo: "credencial_incompleta" };
  }

  const segredosCrus = await decryptWebhookSecret(
    admin,
    linha.secrets_encrypted as unknown as string,
  );
  if (segredosCrus === null) return { ok: false, motivo: "cifra_indisponivel" };

  let segredos: { access_token?: string };
  try {
    segredos = JSON.parse(segredosCrus) as { access_token?: string };
  } catch {
    return { ok: false, motivo: "credencial_incompleta" };
  }
  if (!segredos.access_token) return { ok: false, motivo: "credencial_incompleta" };

  return {
    ok: true,
    credencial: {
      pixelId,
      accessToken: segredos.access_token,
      testEventCode: linha.test_event_code,
    },
  };
}
