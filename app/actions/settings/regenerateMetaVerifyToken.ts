"use server";

import { randomBytes } from "node:crypto";
import { headers } from "next/headers";

import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";

export type RegenerateMetaVerifyTokenResult =
  | { ok: true; webhook_verify_token: string }
  | { ok: false; error: string };

/**
 * Gera/regera o `webhook_verify_token` do App da Meta desta instalação.
 *
 * Ação PRÓPRIA (não um campo a mais em `updateMetaApp`) porque as duas
 * operações têm risco diferente: colar o App Secret é escrever um valor que
 * o admin JÁ TEM em outro lugar (o dashboard da Meta); regerar o verify
 * token é PEDIR um valor novo — e o valor só existe DEPOIS desta chamada, o
 * que faz sentido como um botão próprio ("Gerar"/"Regerar"), não como parte
 * de um formulário que também mexe no secret.
 *
 * O valor cru volta só nesta resposta — nenhuma leitura posterior o
 * devolve (ver `lib/channels/meta/platform-app.ts`, que só expõe
 * `configured`/`source`).
 */
export async function regenerateMetaVerifyToken(): Promise<RegenerateMetaVerifyTokenResult> {
  const { user: authUser } = await requirePlatformAdmin();

  // Mesma entropia que `channel_sessions.webhook_path_token` já usa
  // (`encode(gen_random_bytes(24), 'hex')`) — gerada em TS porque o valor
  // cru precisa voltar NESTA resposta.
  const webhookVerifyToken = randomBytes(24).toString("hex");

  const admin = createAdminClient();
  const { error } = await admin
    .from("platform_meta_app")
    .upsert(
      { id: 1, webhook_verify_token: webhookVerifyToken, updated_by: authUser.id },
      { onConflict: "id" },
    );
  if (error) return { ok: false, error: error.message };

  const cabecalhos = await headers();
  await audit({
    action: "platform_meta_app.verify_token_regenerated",
    actorUserId: authUser.id,
    resourceType: "platform_meta_app",
    resourceId: null,
    requestId: cabecalhos.get("x-request-id") ?? undefined,
    ip: cabecalhos.get("x-forwarded-for") ?? undefined,
    userAgent: cabecalhos.get("user-agent") ?? undefined,
    actingAsPlatformAdmin: true,
    metadata: { campo: "webhook_verify_token" },
  });

  return { ok: true, webhook_verify_token: webhookVerifyToken };
}
