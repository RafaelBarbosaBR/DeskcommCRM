/**
 * O App da Meta EM VIGOR — tela de admin primeiro, `.env` como fallback CAMPO
 * A CAMPO.
 *
 * Antes, `META_APP_SECRET`/`META_WEBHOOK_VERIFY_TOKEN` só existiam no `.env`:
 * uma instalação com o WhatsApp Business Manager de várias empresas por trás
 * do mesmo app da plataforma não tinha onde CADASTRAR isso pela tela — só
 * editando o `.env` do servidor à mão.
 *
 * ⚠️ AS DUAS FUNÇÕES DE LEITURA SÃO INDEPENDENTES DE PROPÓSITO — não existe
 * um `platformMetaAppCreds()` que devolve os dois juntos. `verifyMetaSignature`
 * (POST) só precisa do secret; `verificationChallenge` (GET) só precisa do
 * token. Um getter combinado que exige os DOIS para devolver QUALQUER um dos
 * dois quebraria o caso real de configuração parcial — admin gera o verify
 * token pela tela antes de colar o secret (ou nunca cola um dos dois) — e
 * faria o handshake GET falhar por causa de um secret que o GET nem usa.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

interface LinhaBruta {
  app_secret_encrypted: string | null;
  webhook_verify_token: string | null;
  updated_at: string | null;
}

async function lerLinha(admin: SupabaseClient): Promise<LinhaBruta | null> {
  const { data } = await admin
    .from("platform_meta_app")
    .select("app_secret_encrypted, webhook_verify_token, updated_at")
    .eq("id", 1)
    .maybeSingle();
  return (data as LinhaBruta | null) ?? null;
}

/**
 * O App Secret em vigor — tabela primeiro, `.env` como fallback. `null`
 * quando nenhuma das duas fontes tem um valor utilizável (o chamador trata
 * como "assinatura não pode ser conferida nesta instalação", nunca como
 * erro — mesmo desfecho que `metaCredsFromEnv` já dá pra credencial por
 * sessão).
 */
export async function platformMetaAppSecret(admin: SupabaseClient): Promise<string | null> {
  const linha = await lerLinha(admin);
  if (linha?.app_secret_encrypted) {
    // Decifra que falha (GUC ausente, cifra corrompida) cai no `.env` — o
    // mesmo desfecho de `metaCredsForPhoneNumberId`: melhor a instalação de
    // número único continuar funcionando do que travar por um campo que a
    // tela não conseguiu ler.
    const decifrado = await decryptWebhookSecret(admin, linha.app_secret_encrypted as unknown as string);
    if (decifrado) return decifrado;
  }
  return process.env.META_APP_SECRET || null;
}

/** O verify token em vigor — mesma régua tabela-primeiro do secret. */
export async function platformMetaAppVerifyToken(admin: SupabaseClient): Promise<string | null> {
  const linha = await lerLinha(admin);
  return linha?.webhook_verify_token || process.env.META_WEBHOOK_VERIFY_TOKEN || null;
}

export type FonteDoCampo = "table" | "env" | "none";

export interface PlatformMetaAppStatus {
  /** NUNCA o valor — só se o webhook consegue usar o secret e de onde ele vem. */
  appSecret: { configured: boolean; source: FonteDoCampo };
  webhookVerifyToken: { configured: boolean; source: FonteDoCampo };
  updatedAt: string | null;
}

/**
 * A mesma leitura, sem os valores — para a tela de admin MOSTRAR estado
 * ("configurado, vindo da tabela") sem NUNCA carregar o secret pela rede.
 */
export async function platformMetaAppStatus(admin: SupabaseClient): Promise<PlatformMetaAppStatus> {
  const linha = await lerLinha(admin);

  let appSecretSource: FonteDoCampo = "none";
  let appSecretConfigured = false;
  if (linha?.app_secret_encrypted) {
    const decifrado = await decryptWebhookSecret(admin, linha.app_secret_encrypted as unknown as string);
    if (decifrado) {
      appSecretConfigured = true;
      appSecretSource = "table";
    }
  }
  if (!appSecretConfigured && process.env.META_APP_SECRET) {
    appSecretConfigured = true;
    appSecretSource = "env";
  }

  const tokenDaTabela = linha?.webhook_verify_token ?? null;
  const webhookVerifyTokenSource: FonteDoCampo = tokenDaTabela
    ? "table"
    : process.env.META_WEBHOOK_VERIFY_TOKEN
      ? "env"
      : "none";

  return {
    appSecret: { configured: appSecretConfigured, source: appSecretSource },
    webhookVerifyToken: {
      configured: webhookVerifyTokenSource !== "none",
      source: webhookVerifyTokenSource,
    },
    updatedAt: linha?.updated_at ?? null,
  };
}
