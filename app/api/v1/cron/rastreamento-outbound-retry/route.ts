/**
 * GET/POST /api/v1/cron/rastreamento-outbound-retry
 *
 * O varredor de retry de `outbound_events` — item 1 do pedido de auditoria
 * de rastreamento ("um job agendado de curto intervalo varre a fila e
 * reprocessa qualquer coisa pendente ou com nova tentativa já vencida").
 *
 * ── Por que este cron, e não o `event-log-drain` de sempre ──────────────────
 *
 * A 1ª tentativa de cada linha de `outbound_events` é o `event_log` (via
 * `despacho.handler.ts`, disparado no ato pelo despacho imediato de
 * `registrar-evento.ts`, com o `event-log-drain` de 1×/min como rede de
 * segurança). Mas UMA vez que a linha existe, o dono do retry dela é ESTE
 * cron — o `event_log` não retenta mais (`handle()` sempre devolve `ok`
 * depois da 1ª tentativa, mesmo se ela falhou). Duas filas retentando o
 * mesmo envio reagendariam a mesma chamada duas vezes; aqui há UM dono.
 *
 * ── O que ele faz ────────────────────────────────────────────────────────
 *
 *   1. Reclama `processing` preso (>10min) — mesmo motivo do reaper do
 *      `event_log`: um processo que morre no meio da chamada de rede não
 *      pode travar a linha pra sempre.
 *   2. Varre `outbound_events` com `status='pending'` E `next_retry_at`
 *      vencido (ou nulo — a linha nasceu e a 1ª tentativa não rodou por
 *      algum motivo; ver o comentário da coluna na migration 0242).
 *   3. Reusa `tentarEnviarParaProvider` — a MESMA função que a 1ª tentativa
 *      usa. Backoff, `MAX_TENTATIVAS`, sanitização e o log bruto em
 *      `platform_event_logs` são o mesmo código, não uma segunda cópia.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET |
 * INTERNAL_SECRET, fail-closed).
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  COLUNAS_DO_EVENTO_INTERNO,
  tentarEnviarParaProvider,
  type InternalEventRow,
  type Provider,
} from "@/lib/rastreamento/motor/despacho.handler";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Depois disto, uma linha em `processing` é considerada órfã e volta a `pending`. */
const PROCESSING_STALE_MS = 10 * 60 * 1000;

export interface ResumoDoRetry {
  varridos: number;
  enviados: number;
  reagendados: number;
  esgotados: number;
  presos_devolvidos: number;
}

/**
 * Separada do handler HTTP pro teste exercitar a REGRA sem montar
 * request/auth — mesmo desenho de `podarHistorico` (data-retention) e
 * `recoverStuckMessages`.
 */
export async function processarRetries(
  admin: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<ResumoDoRetry> {
  const limit = opts.limit ?? 50;
  const nowIso = new Date().toISOString();

  const limiteDePresos = new Date(Date.now() - PROCESSING_STALE_MS).toISOString();
  const { data: presos } = await admin
    .from("outbound_events")
    .update({ status: "pending" })
    .eq("status", "processing")
    .lt("last_attempt_at", limiteDePresos)
    .select("id");
  if (presos?.length) {
    logger.warn("[rastreamento.outbound-retry] linhas presas em processing devolvidas à fila", {
      quantidade: presos.length,
    });
  }

  const { data: rows, error } = await admin
    .from("outbound_events")
    .select("id, internal_event_id, provider")
    .eq("status", "pending")
    .or(`next_retry_at.is.null,next_retry_at.lte.${nowIso}`)
    .order("next_retry_at", { ascending: true, nullsFirst: true })
    .limit(limit);

  const resumo: ResumoDoRetry = {
    varridos: 0,
    enviados: 0,
    reagendados: 0,
    esgotados: 0,
    presos_devolvidos: presos?.length ?? 0,
  };

  if (error) {
    logger.error("[rastreamento.outbound-retry] select falhou", { error: error.message });
    return resumo;
  }

  // Cache por `internal_event_id`: várias linhas devidas podem apontar pro
  // MESMO evento interno (ex.: Meta e GA4 falharam juntos, os dois vencem no
  // mesmo tick) — sem isto seria uma leitura de `internal_events` a mais por
  // provider, à toa.
  const eventosCache = new Map<string, InternalEventRow | null>();

  for (const row of (rows ?? []) as { id: string; internal_event_id: string; provider: Provider }[]) {
    resumo.varridos += 1;

    let evento = eventosCache.get(row.internal_event_id);
    if (evento === undefined) {
      const { data } = await admin
        .from("internal_events")
        .select(COLUNAS_DO_EVENTO_INTERNO)
        .eq("id", row.internal_event_id)
        .maybeSingle();
      evento = (data as InternalEventRow | null) ?? null;
      eventosCache.set(row.internal_event_id, evento);
    }
    // `internal_events` nunca é apagado (princípio 3 do pedido) — chegar
    // aqui sem ele é defensivo, não um caminho esperado.
    if (!evento) continue;

    const desfecho = await tentarEnviarParaProvider(admin, evento, row.provider, row.id);
    if (desfecho === "sent") resumo.enviados += 1;
    else if (desfecho === "pending") resumo.reagendados += 1;
    else if (desfecho === "dead_letter") resumo.esgotados += 1;
    // "not_claimed" (corrida com outra instância) não conta em nenhum balde
    // — não é trabalho feito nem trabalho perdido, é a mesma linha que outro
    // tick já está processando.
  }

  return resumo;
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const headerSecret = req.headers.get("x-cron-secret")?.trim() ?? "";
  const provided = bearer || headerSecret;

  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  try {
    const resumo = await processarRetries(createAdminClient());
    return ok(resumo, { requestId });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[rastreamento.outbound-retry] threw", { error: detail, requestId });
    return fail("internal_error", detail, 500, { requestId });
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
