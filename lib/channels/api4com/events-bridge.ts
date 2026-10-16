/**
 * Webhook api4com → `voice_calls` + linha do tempo do negócio (M1).
 *
 * ═══ Correlação: pelo `voice_call_id` que NÓS mandamos, nunca por telefone ═══
 *
 * `POST /calls` (api4com) devolve `metadata` inteiro no webhook — "Todas as
 * chaves e valores são enviados no webhook da chamada" (doc pública). Em vez
 * de resolver o contato de novo por número (a doc não garante formato E.164
 * no corpo do evento, e reabrir essa pergunta no webhook duplicaria a lógica
 * que o `POST /api/v1/calls` já resolveu ANTES de discar), mandamos
 * `metadata.voice_call_id = <id da linha que acabamos de inserir>` na
 * chamada de origem (`app/api/v1/calls/route.ts`). O webhook só precisa achar
 * essa linha — mesmo espírito do `channelId` gerado ANTES do originate em
 * `lib/voip/ariClient.ts`, que fecha a mesma classe de corrida.
 *
 * ═══ Shape do payload: defensivo de propósito ═══
 *
 * A documentação pública da api4com NÃO publica o schema exato do corpo do
 * webhook (só a config de registro — `webhookTypes`). O parser abaixo aceita
 * os formatos razoáveis vistos na doc do objeto Call (`id`, `started_at`,
 * `ended_at`, `hangup_cause`, `duration`) e nunca lança em campo ausente —
 * sempre responde 200 rápido (a api4com reentrega em erro) e loga o que não
 * reconheceu, para ajustar contra o payload REAL assim que houver uma conta
 * de teste. ⚠️ Verificar contra tráfego real antes de confiar nesta rota como
 * única fonte de verdade de duração/motivo.
 *
 * ═══ Sem assinatura ═══
 *
 * A doc não documenta HMAC/assinatura no webhook da api4com (diferente do
 * WAHA, que assina HMAC SHA512). A defesa é só o `webhook_path_token` (32
 * bytes aleatórios) no caminho — mesmo nível de `app/api/v1/webhooks/in/[token]`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { logger } from "@/lib/logger";

export interface Api4comWebhookPayload {
  /** `channel-answer` | `channel-hangup` — a doc não nomeia o campo do tipo com certeza. */
  type?: string;
  event?: string;
  id?: string;
  started_at?: string;
  answered_at?: string;
  ended_at?: string;
  duration?: number;
  hangup_cause?: string;
  metadata?: { voice_call_id?: string; [k: string]: unknown };
}

/** `channel-answer` em qualquer um dos formatos de campo plausíveis. */
function ehAtendida(payload: Api4comWebhookPayload): boolean {
  return payload.type === "channel-answer" || payload.event === "channel-answer";
}

/** `channel-hangup` em qualquer um dos formatos de campo plausíveis. */
function ehEncerrada(payload: Api4comWebhookPayload): boolean {
  return payload.type === "channel-hangup" || payload.event === "channel-hangup";
}

export interface ProcessarWebhookResult {
  ok: boolean;
  /** Para log/diagnóstico — nunca muda o código HTTP (sempre 200, ver cabeçalho). */
  reason?: string;
}

/**
 * Aplica um evento de webhook a UMA linha de `voice_calls` (a que
 * `metadata.voice_call_id` aponta) e, só no encerramento, espelha na timeline
 * do negócio.
 */
export async function processarWebhookApi4com(
  admin: SupabaseClient,
  organizationId: string,
  payload: Api4comWebhookPayload,
): Promise<ProcessarWebhookResult> {
  const voiceCallId = payload.metadata?.voice_call_id;
  if (!voiceCallId) {
    logger.warn("[api4com.webhook] sem metadata.voice_call_id — evento não correlacionável", {
      organizationId,
      providerCallId: payload.id ?? null,
    });
    return { ok: false, reason: "sem_voice_call_id" };
  }

  // organization_id À MÃO, mesmo vindo de um service client: o webhook_path_token
  // já proveu o tenant (rota), mas a escrita confere de novo — defesa em
  // profundidade igual ao resto dos webhooks deste repo.
  const { data: chamada, error: selErr } = await admin
    .from("voice_calls")
    .select("id, lead_id, contact_id, owner_user_id, status, answered_at")
    .eq("id", voiceCallId)
    .eq("organization_id", organizationId)
    .eq("provider", "api4com")
    .maybeSingle();
  if (selErr) {
    logger.error("[api4com.webhook] falha ao buscar voice_calls", { organizationId, error: selErr.message });
    return { ok: false, reason: "select_failed" };
  }
  if (!chamada) {
    // Chamada de outra organização, ou id forjado: no-op silencioso, nunca
    // erro — não é uma falha, é um evento que não é nosso ou já foi apagado.
    return { ok: false, reason: "voice_call_not_found" };
  }

  if (ehAtendida(payload)) {
    if (chamada.status === "ended") return { ok: true, reason: "ja_encerrada" }; // tardio, no-op
    const { error } = await admin
      .from("voice_calls")
      .update({ status: "connected", answered_at: payload.answered_at ?? new Date().toISOString() })
      .eq("id", chamada.id);
    if (error) {
      logger.error("[api4com.webhook] falha ao marcar atendida", { organizationId, error: error.message });
      return { ok: false, reason: "update_answer_failed" };
    }
    return { ok: true };
  }

  if (!ehEncerrada(payload)) {
    logger.warn("[api4com.webhook] tipo de evento desconhecido", { organizationId, payload });
    return { ok: false, reason: "tipo_desconhecido" };
  }

  // channel-hangup: idempotente — reentrega da api4com não duplica o fim.
  if (chamada.status === "ended") return { ok: true, reason: "ja_encerrada" };

  const endedAt = payload.ended_at ?? new Date().toISOString();
  const durationMs = typeof payload.duration === "number" ? Math.round(payload.duration * 1000) : null;
  const foiAtendida = chamada.answered_at != null || payload.answered_at != null;

  const { error: updErr } = await admin
    .from("voice_calls")
    .update({
      status: "ended",
      end_reason: payload.hangup_cause ?? null,
      ended_at: endedAt,
      duration_ms: durationMs,
      provider_call_id: payload.id ?? null,
    })
    .eq("id", chamada.id);
  if (updErr) {
    logger.error("[api4com.webhook] falha ao marcar encerrada", { organizationId, error: updErr.message });
    return { ok: false, reason: "update_hangup_failed" };
  }

  // Espelha na timeline do NEGÓCIO (não do contato) — mesmo vocabulário que o
  // WaCalls já usa, nenhum tipo novo. Sem lead vinculado, não há onde gravar:
  // a chamada ainda fica no histórico de /app/calls, só não ganha linha na
  // timeline de um negócio que não existe.
  if (chamada.lead_id) {
    const atividade = await emitLeadActivity(admin, {
      organizationId,
      leadId: chamada.lead_id,
      contactId: chamada.contact_id,
      type: foiAtendida ? "voice_call" : "voice_call_unanswered",
      sourceModule: "api4com",
      sourceId: payload.id ?? chamada.id,
      actor: chamada.owner_user_id
        ? { type: "user", id: chamada.owner_user_id }
        : { type: "webhook_source", id: "api4com" },
      reason: foiAtendida ? "Chamada de voz" : "Chamada de voz sem resposta",
    });
    if (!atividade.ok) {
      logger.error("[api4com.webhook] falha ao gravar atividade na timeline", {
        organizationId,
        leadId: chamada.lead_id,
        error: atividade.error,
      });
      // Não falha o webhook por isso: a chamada já está gravada em voice_calls,
      // que é a fonte de verdade — a timeline é espelho, não origem.
    }
  }

  return { ok: true };
}
