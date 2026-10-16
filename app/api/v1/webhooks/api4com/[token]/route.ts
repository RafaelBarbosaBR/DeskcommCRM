/**
 * POST /api/v1/webhooks/api4com/[token]
 *
 * Rota per-organização: cada `api4com_connections` tem um
 * `webhook_path_token` único (32 bytes aleatórios), gravado na api4com via
 * `PATCH /integrations` no momento da conexão (`connect.ts`). Sem assinatura
 * HMAC documentada pela api4com — a defesa é o próprio token no caminho,
 * mesmo nível de `app/api/v1/webhooks/in/[token]`.
 *
 * Sempre responde 200 rápido: evento não correlacionável (sem
 * `metadata.voice_call_id`) ou de chamada já encerrada é log, nunca erro —
 * forçar a api4com a reentregar um evento que não vamos conseguir usar só
 * multiplicaria tráfego sem ganho.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { processarWebhookApi4com, type Api4comWebhookPayload } from "@/lib/channels/api4com/events-bridge";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ token: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { token } = await ctx.params;

  if (!token || token.length < 16) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  const admin = createAdminClient();

  // organization_id vem SÓ do token do caminho — nunca do corpo. Mesmo padrão
  // de todo webhook per-organização deste repo (doutrina de restrição de canal).
  const { data: conexao, error: lookupErr } = await admin
    .from("api4com_connections")
    .select("organization_id")
    .eq("webhook_path_token", token)
    .maybeSingle();
  if (lookupErr) {
    logger.error("[api4com.webhook] falha ao resolver organização pelo token", { error: lookupErr.message });
    return fail("internal_error", lookupErr.message, 500, { requestId });
  }
  if (!conexao) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  let payload: Api4comWebhookPayload;
  try {
    payload = (await req.json()) as Api4comWebhookPayload;
  } catch {
    // Corpo ilegível: 200 mesmo assim — não é um evento que vamos conseguir
    // usar nem reentregando, e devolver erro só ensina a api4com a tentar de
    // novo pelo mesmo motivo.
    logger.warn("[api4com.webhook] corpo não é JSON válido", { organizationId: conexao.organization_id });
    return ok({ received: true }, { requestId });
  }

  const resultado = await processarWebhookApi4com(admin, conexao.organization_id as string, payload);
  if (!resultado.ok) {
    logger.info("[api4com.webhook] evento não aplicado", {
      organizationId: conexao.organization_id,
      reason: resultado.reason,
    });
  }

  await admin
    .from("api4com_connections")
    .update({ last_webhook_at: new Date().toISOString() })
    .eq("organization_id", conexao.organization_id as string);

  return ok({ received: true }, { requestId });
}
