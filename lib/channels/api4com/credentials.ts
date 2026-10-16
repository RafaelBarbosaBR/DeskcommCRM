/**
 * Credenciais da conta api4com — uma por organização (migration 0629).
 *
 * `organization_id` é a CHAVE PRIMÁRIA de `api4com_connections` (mesmo desenho
 * de `voip_trunk_settings`/`org_voice_calls`): config de UMA conta por
 * organização, não lista. A cifra usa as MESMAS RPCs do resto do repo
 * (`fn_encrypt_oauth`/`fn_decrypt_oauth`, ver `lib/webhooks/secrets.ts`) — só o
 * TOKEN é cifrado; a senha da conta api4com nunca chega a esta tabela (ver
 * `connect.ts`, que a troca por um token permanente e descarta na mesma
 * requisição).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface Api4comCredentials {
  domain: string;
  accessToken: string;
}

/**
 * A credencial decifrada desta organização, ou `null` quando não há conta
 * conectada / a conexão não está `healthy` / a cifra falhou (chave mestra
 * ausente nesta instalação). `null` é sempre "não dá para originar chamada
 * por aqui" — o chamador cai no comportamento de hoje (trunk SIP), nunca
 * lança.
 */
export async function api4comCredsForOrg(
  admin: SupabaseClient,
  organizationId: string,
): Promise<Api4comCredentials | null> {
  const { data, error } = await admin
    .from("api4com_connections")
    .select("domain, access_token_encrypted, status")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) {
    throw new Error(`api4com_creds_lookup_failed: ${error.code ?? "sem_codigo"} ${error.message ?? ""}`.trim());
  }
  if (!data || data.status !== "healthy") return null;

  const accessToken = await decryptWebhookSecret(admin, data.access_token_encrypted as unknown as string);
  if (!accessToken) return null;

  return { domain: data.domain as string, accessToken };
}

/** O ramal api4com mapeado para este usuário nesta organização, ou `null`. */
export async function api4comExtensionForUser(
  admin: SupabaseClient,
  organizationId: string,
  userId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("api4com_extensions")
    .select("extension")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    throw new Error(`api4com_extension_lookup_failed: ${error.code ?? "sem_codigo"} ${error.message ?? ""}`.trim());
  }
  return (data?.extension as string | undefined) ?? null;
}
