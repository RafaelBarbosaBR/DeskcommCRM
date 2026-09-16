"use server";

import { headers } from "next/headers";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export type UpdateMetaAppResult = { ok: true } | { ok: false; error: string; details?: unknown };

/**
 * Cadastra o App Secret da Meta (WhatsApp Cloud API) DESTA INSTALAÇÃO — sem
 * SSH e sem editar `.env`. Espelha `updateGoogleOAuth.ts` byte a byte na
 * estrutura, porque é a MESMA classe de problema: config de PLATAFORMA
 * (o app da Meta serve N WABAs de N organizações), cadastrada só via
 * `META_APP_SECRET` no `.env` até aqui.
 *
 * ── Por que o gate é `is_platform_admin` ─────────────────────────────────────
 *
 * Um revendedor que hospeda várias empresas atrás do MESMO app da Meta não
 * pode deixar o admin de um tenant trocar o secret — derrubaria a assinatura
 * de TODO webhook, de TODAS as organizações, ao mesmo tempo.
 *
 * ── NUNCA em claro ────────────────────────────────────────────────────────────
 *
 * Se `fn_encrypt_oauth` não puder cifrar (chave mestra ausente na
 * instalação), o save RECUSA — mesma decisão de `updateGoogleOAuth.ts` e de
 * `app/api/v1/channels/official/route.ts`: texto puro seria pior que "não dá
 * para configurar".
 */
const entradaSchema = z.object({
  app_secret: z.string().trim().min(1).max(4000),
});

export type UpdateMetaAppInput = z.infer<typeof entradaSchema>;

export async function updateMetaApp(input: UpdateMetaAppInput): Promise<UpdateMetaAppResult> {
  const { user: authUser } = await requirePlatformAdmin();

  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input", details: parsed.error.flatten() };
  }

  const admin = createAdminClient();
  const cifrado = await encryptWebhookSecret(admin, parsed.data.app_secret);
  if (!cifrado) {
    return {
      ok: false,
      error:
        "cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o secret não foi gravado",
    };
  }

  const { error } = await admin
    .from("platform_meta_app")
    // `upsert`, não `update`: a linha não existe numa instalação que nunca
    // configurou o app da Meta pela tela, e um `update` casaria zero linhas
    // devolvendo SUCESSO — a mesma armadilha que `updateGoogleOAuth.ts` evita.
    .upsert(
      { id: 1, app_secret_encrypted: cifrado, updated_by: authUser.id },
      { onConflict: "id" },
    );
  if (error) return { ok: false, error: error.message };

  const cabecalhos = await headers();
  await audit({
    action: "platform_meta_app.secret_updated",
    actorUserId: authUser.id,
    // Sem `organizationId`: config da instalação, não de um tenant.
    resourceType: "platform_meta_app",
    // `null`, não `"1"` — `api_audit_log.resource_id` é uuid; a chave natural
    // do singleton estouraria o INSERT do audit com 22P02.
    resourceId: null,
    requestId: cabecalhos.get("x-request-id") ?? undefined,
    ip: cabecalhos.get("x-forwarded-for") ?? undefined,
    userAgent: cabecalhos.get("user-agent") ?? undefined,
    actingAsPlatformAdmin: true,
    // O QUE mudou, jamais o valor — o secret não entra em metadata.
    metadata: { campo: "app_secret" },
  });

  return { ok: true };
}
