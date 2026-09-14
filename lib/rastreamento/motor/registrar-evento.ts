import type { SupabaseClient } from "@supabase/supabase-js";

import { drainEventLog } from "@/lib/event-log/drain";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";
import { logger } from "@/lib/logger";
import type { TipoDeEventoInterno } from "./types";

export interface RegistrarEventoInternoInput {
  organizationId: string;
  trackingSiteId?: string | null;
  tipo: TipoDeEventoInterno;
  visitorId?: string | null;
  sessionId?: string | null;
  contactId?: string | null;
  leadId?: string | null;
  touchpointId?: string | null;
  valorCentavos?: number | null;
  moeda?: string | null;
  ocorridoEm?: Date;
  payload?: Record<string, unknown>;
}

/**
 * Grava um dos 5 eventos internos e enfileira o despacho pros providers
 * (via `event_log`, consumido por `despacho.handler.ts`).
 *
 * Idempotente pra LEAD/QUALIFIED/PURCHASE: o índice único parcial
 * `internal_events_lead_event_uk` (migration 0234) faz o segundo INSERT do
 * mesmo (organization, lead, tipo) virar 23505 — devolvido aqui como `null`
 * silencioso, não como erro, porque é o caminho esperado (ex.: o gatilho de
 * `lead.stage_changed` roda tanto por trigger quanto por rota de app, e as
 * duas emissões não podem virar dois PURCHASE pra Meta).
 */
export async function registrarEventoInterno(
  admin: SupabaseClient,
  input: RegistrarEventoInternoInput,
): Promise<{ id: string } | null> {
  const { data, error } = await admin
    .from("internal_events")
    .insert({
      organization_id: input.organizationId,
      tracking_site_id: input.trackingSiteId ?? null,
      event_type: input.tipo,
      visitor_id: input.visitorId ?? null,
      session_id: input.sessionId ?? null,
      contact_id: input.contactId ?? null,
      lead_id: input.leadId ?? null,
      touchpoint_id: input.touchpointId ?? null,
      value_cents: input.valorCentavos ?? null,
      currency: input.moeda ?? null,
      occurred_at: (input.ocorridoEm ?? new Date()).toISOString(),
      payload: input.payload ?? {},
    })
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      logger.info("[rastreamento.motor] evento já registrado, ignorando", {
        organizationId: input.organizationId,
        tipo: input.tipo,
        leadId: input.leadId ?? null,
      });
      return null;
    }
    logger.error("[rastreamento.motor] falha ao registrar evento interno", {
      organizationId: input.organizationId,
      tipo: input.tipo,
      error: error.message,
    });
    return null;
  }
  if (!data) return null;

  const eventoId = (data as { id: string }).id;

  const { data: eventLogId, error: emitError } = await admin.rpc("emit_event", {
    p_event_type: "tracking.internal_event_created",
    p_entity_kind: "internal_event",
    p_entity_id: eventoId,
    p_payload: { event_type: input.tipo },
    p_metadata: {},
    p_organization_id: input.organizationId,
  });
  if (emitError) {
    logger.error("[rastreamento.motor] falha ao enfileirar despacho", {
      organizationId: input.organizationId,
      internalEventId: eventoId,
      error: emitError.message,
    });
    return { id: eventoId };
  }

  // ─── "TEMPO REAL" = tentar AGORA, na MESMA EXECUÇÃO — não esperar o cron ──
  //
  // `emit_event` só INSERE a linha em `event_log`; sem esta chamada, o envio
  // pra Meta/GA4/Google Ads só aconteceria no próximo tick do
  // `event-log-drain` (cron de 1×/min). O pedido é explícito: "disparado
  // IMEDIATAMENTE em seguida, na mesma execução — não espera nenhum cron".
  //
  // `drainEventLog(..., { somenteId })` reaproveita o laço inteiro do drain
  // (claim otimista, `dispatchEvent`, aplicação do resultado) restrito a ESTA
  // linha — é a MESMA lógica que o cron roda, só que agora, e sem duplicá-la
  // (ver o cabeçalho de `somenteId` em `drain.ts`).
  //
  // NUNCA LANÇA: se o despacho imediato falhar (rede fora do ar, provider
  // fora do ar), a linha continua `pending` em `event_log` exatamente como
  // ficaria se esta chamada nem existisse — o cron de 1×/min é a rede de
  // segurança que sempre existiu. "Tempo real" veio a mais; ele nunca pode
  // ser o único caminho.
  try {
    ensureHandlersRegistered();
    await drainEventLog(admin, { limit: 1, somenteId: eventLogId as string });
  } catch (erro) {
    logger.error("[rastreamento.motor] despacho imediato falhou; cron de 1×/min cobre", {
      organizationId: input.organizationId,
      internalEventId: eventoId,
      error: erro instanceof Error ? erro.message : String(erro),
    });
  }

  return { id: eventoId };
}
