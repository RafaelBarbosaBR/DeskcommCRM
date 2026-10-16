/**
 * CONECTAR A CONTA api4com DE UMA ORGANIZAÇÃO — o miolo, sem HTTP.
 *
 * Mesmo espírito de `lib/voip/guardar-trunk.ts`: cifrar (nunca plaintext em
 * disco), uma linha por organização, auditar. A diferença que importa: a
 * SENHA da conta api4com nunca é persistida, nem de passagem — ela entra
 * nesta função, faz UMA chamada de login, e sai do escopo. O que fica gravado
 * é um token que NUNCA EXPIRA (`ttl: -1`, `POST /users/accessTokens`),
 * cifrado pela mesma RPC que o resto do repo usa pra token de terceiro
 * (`fn_encrypt_oauth`, ver `lib/webhooks/secrets.ts`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { api4comLogin, api4comMintPermanentToken, api4comUpsertWebhook, api4comWhoAmI } from "./client";

export type ResultadoDeConectarApi4com =
  | { ok: true }
  | {
      ok: false;
      motivo: "login_invalido" | "cifragem" | "banco" | "webhook";
      detalhe?: string;
    };

export interface PedidoDeConectarApi4com {
  admin: SupabaseClient;
  orgId: string;
  userId: string;
  email: string;
  password: string;
  domain: string;
}

function webhookUrlDaInstalacao(webhookPathToken: string): string {
  const base = (env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
  return `${base}/api/v1/webhooks/api4com/${webhookPathToken}`;
}

export async function conectarApi4com(p: PedidoDeConectarApi4com): Promise<ResultadoDeConectarApi4com> {
  let loginToken: string;
  let contaEmail: string;
  let permanentToken: string;
  try {
    const login = await api4comLogin(p.email, p.password);
    loginToken = login.token;
    const quemSou = await api4comWhoAmI(loginToken);
    contaEmail = quemSou.email;
    permanentToken = await api4comMintPermanentToken(loginToken);
  } catch (err) {
    // Qualquer falha no login/troca de token (credencial errada, rede,
    // formato de resposta inesperado) é "não deu pra conectar com isso" do
    // ponto de vista de quem preencheu o formulário — a mensagem exata fica
    // no `detalhe`, pro log, não pra régua de decisão.
    return { ok: false, motivo: "login_invalido", detalhe: err instanceof Error ? err.message : undefined };
  }

  const cifrado = await encryptWebhookSecret(p.admin, permanentToken);
  if (!cifrado) {
    return { ok: false, motivo: "cifragem", detalhe: "chave mestra de cifra ausente nesta instalação" };
  }

  const { data: existente } = await p.admin
    .from("api4com_connections")
    .select("organization_id")
    .eq("organization_id", p.orgId)
    .maybeSingle();

  const { data: salvo, error: upsertErr } = await p.admin
    .from("api4com_connections")
    .upsert(
      {
        organization_id: p.orgId,
        domain: p.domain,
        access_token_encrypted: cifrado,
        account_email: contaEmail,
        status: "connecting",
        created_by: p.userId,
      },
      { onConflict: "organization_id" },
    )
    .select("webhook_path_token")
    .single();

  if (upsertErr || !salvo) {
    return { ok: false, motivo: "banco", detalhe: upsertErr?.message };
  }

  try {
    await api4comUpsertWebhook(
      permanentToken,
      webhookUrlDaInstalacao(salvo.webhook_path_token as string),
    );
  } catch (err) {
    return { ok: false, motivo: "webhook", detalhe: err instanceof Error ? err.message : undefined };
  }

  await p.admin
    .from("api4com_connections")
    .update({ status: "healthy" })
    .eq("organization_id", p.orgId);

  await audit({
    action: existente ? "api4com.reconnected" : "api4com.connected",
    actorUserId: p.userId,
    organizationId: p.orgId,
    resourceType: "api4com_connections",
    resourceId: p.orgId,
    metadata: { domain: p.domain, account_email: contaEmail },
  });

  return { ok: true };
}

/** Desconecta: apaga a credencial. O mapeamento de ramais (`api4com_extensions`) fica — reconectar não exige remapear. */
export async function desconectarApi4com(
  admin: SupabaseClient,
  orgId: string,
  userId: string,
): Promise<void> {
  await admin.from("api4com_connections").delete().eq("organization_id", orgId);
  await audit({
    action: "api4com.disconnected",
    actorUserId: userId,
    organizationId: orgId,
    resourceType: "api4com_connections",
    resourceId: orgId,
    metadata: {},
  });
}
