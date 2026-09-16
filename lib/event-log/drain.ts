/**
 * Cron driver genérico do event_log — a peça prometida em dispatcher.ts.
 *
 * Seleciona SÓ event_types com handler registrado: tipos drenados por crons
 * dedicados (ex. ai_agent.dispatch_requested → agent-dispatcher) não têm
 * handler no registry e ficam intocados.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { dispatchEvent, getRegisteredHandlers, type EventRow } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";

const MAX_ATTEMPTS = 5;

/** Depois disto, um evento em `processing` é considerado órfão e volta à fila. */
const PROCESSING_STALE_MS = 10 * 60 * 1000;

export interface DrainSummary {
  /**
   * Os `skipped` COM motivo, para o resumo poder ser lido de fora do banco.
   *
   * Opcional de propósito: quem monta um `DrainSummary` literal (por exemplo
   * `tests/unit/event-log-drain-loop.test.ts`) não precisa mudar.
   */
  pulados?: string[];
  scanned: number;
  done: number;
  retried: number;
  failed: number;
  dead: number;
}

function backoffAt(attempts: number): string {
  // 1min, 2min, 4min, 8min... (2^n minutos)
  const minutes = Math.pow(2, attempts);
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/**
 * O `event_dead` ÓRFÃO (Onda 4.6): este ramo marcava `status='dead'` sem
 * nunca abrir aviso — o `event_type` some do produto sem deixar rastro
 * visível a quem opera. Os 3 tipos contáveis (`crm.activity_write_failed`,
 * `whatsapp.chat_id_not_recognized`, `whatsapp.conversation_mark_failed`,
 * Onda 2.6) nascem já `done` e nunca chegam aqui — todo `dead` que passa por
 * este ponto é, por construção, acionável.
 *
 * Mesmo padrão de `avisarMidiaNaoLida` (`workers/media-derive-worker.ts`): um
 * aviso por organização enquanto o problema durar, fire-and-forget (o dreno
 * não pode travar porque o aviso falhou), erro do INSERT CONFERIDO (não só
 * capturado) — supabase-js devolve `{ error }` em vez de lançar.
 */
async function avisarEventoMorto(
  admin: SupabaseClient,
  row: EventRow,
  motivo: string,
): Promise<void> {
  try {
    const { data: jaAberto } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", row.organization_id)
      .eq("kind", "event_dead")
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (jaAberto) return;

    const { error } = await admin.from("agent_inbox_items").insert({
      organization_id: row.organization_id,
      kind: "event_dead",
      severity: "critical",
      title: "Um evento recebido não pôde ser processado",
      body: `event_type=${row.event_type}; attempts=${row.attempts + 1}\nMotivo: ${motivo.slice(0, 400)}`,
    });
    if (error) {
      logger.warn("[event-log.drain] o banco recusou o aviso de event_dead", {
        organization_id: row.organization_id,
        error: error.message,
      });
    }
  } catch (err) {
    logger.warn("[event-log.drain] falha ao avisar event_dead", {
      organization_id: row.organization_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function drainEventLog(
  admin: SupabaseClient,
  opts: {
    limit?: number;
    /**
     * Restringe o SELECT a UMA linha específica — o despacho imediato
     * (`lib/rastreamento/motor/registrar-evento.ts`) usa isto pra processar o
     * `event_log` que acabou de inserir NA MESMA EXECUÇÃO, em vez de esperar o
     * próximo tick do cron. Reaproveita o laço inteiro (claim otimista,
     * backoff, `MAX_ATTEMPTS`, reaper de `processing` preso) em vez de
     * duplicá-lo: aditivo, então quem não passa isto (o cron de sempre) roda
     * exatamente como antes.
     */
    somenteId?: string;
  } = {},
): Promise<DrainSummary> {
  const limit = opts.limit ?? 50;
  const summary: DrainSummary = {
    scanned: 0,
    done: 0,
    retried: 0,
    failed: 0,
    dead: 0,
    pulados: [],
  };

  const handledTypes = [...new Set(getRegisteredHandlers().flatMap((h) => h.events))];
  if (!handledTypes.length) return summary;

  const nowIso = new Date().toISOString();

  // ─── EVENTO PRESO EM `processing` VOLTA PARA A FILA ────────────────────────
  //
  // A linha é marcada `processing` ANTES de o handler rodar, e NADA no produto
  // a devolvia: um handler que não retorna — processo derrubado no meio, OOM,
  // ida a um serviço externo sem timeout — deixava o evento preso para SEMPRE.
  // Não é hipótese: foi medido nesta frente com o Redis do debounce apontando
  // para uma porta sem ninguém escutando. O evento ficou `processing`,
  // `attempts=0`, `consumed_by` vazio, e o material que a pessoa cadastrou
  // nunca foi preparado — sem erro em lugar nenhum, e sem uma segunda chance.
  //
  // `job_queue` tem reaper desde sempre; o `event_log` não tinha. É o
  // invariante 4 do Sistema Vivo (nenhuma demanda sem próximo passo) aplicado à
  // fila de eventos.
  //
  // A janela é generosa de propósito: o handler mais lento do registry é um
  // turno de agente, e reclamar cedo demais faria DOIS workers agirem sobre o
  // mesmo evento — trocar um evento parado por um efeito em dobro.
  //
  // `updated_at` é confiável como "quando alguém tocou esta linha": o trigger
  // `trg_event_log_touch` (BEFORE UPDATE) o reescreve em toda atualização, então
  // a linha carrega o instante do CLAIM enquanto o handler não volta.
  // Pulado no despacho imediato (`somenteId`): é manutenção de FROTA (varre
  // TODO `processing` preso), e quem chama com `somenteId` já roda dentro de
  // uma requisição por evento — a cada pageview rastreado, potencialmente. O
  // cron de sempre (sem `somenteId`, 1×/min) continua sendo o único dono
  // desta faxina, do mesmo jeito que sempre foi.
  if (!opts.somenteId) {
    const limiteDePresos = new Date(Date.now() - PROCESSING_STALE_MS).toISOString();
    const { data: reclamados } = await admin
      .from("event_log")
      .update({ status: "pending", updated_at: nowIso })
      .eq("status", "processing")
      .lt("updated_at", limiteDePresos)
      .select("id");
    if (reclamados?.length) {
      logger.warn("[event-log.drain] eventos presos em processing devolvidos à fila", {
        quantidade: reclamados.length,
      });
    }
  }

  let consulta = admin
    .from("event_log")
    // `created_at` viaja porque um consumidor não consegue distinguir "evento de
    // agora" de "evento de três dias parado em `pending`" sem ele — e o drain
    // leva 50 por tick sem janela de recência, então um backlog vira enxurrada
    // de efeitos com data errada no primeiro tick depois de um deploy.
    .select(
      "id, organization_id, event_type, entity_kind, entity_id, payload, metadata, consumed_by, attempts, created_at",
    )
    .eq("status", "pending")
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
    .in("event_type", handledTypes);
  if (opts.somenteId) consulta = consulta.eq("id", opts.somenteId);
  const { data: rows, error } = await consulta
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    logger.error("[event-log.drain] select failed", { error: error.message });

    return summary;
  }

  for (const raw of rows ?? []) {
    const row = raw as unknown as EventRow;
    summary.scanned += 1;

    // Claim otimista — outra instância pode ter pego a mesma linha.
    const { data: claimed } = await admin
      .from("event_log")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id");
    if (!claimed?.length) continue;

    const results = await dispatchEvent(row);

    const okKeys = results
      .filter((r) => r.status === "ok" || r.status === "skipped")
      .map((r) => r.consumer_key);
    const consumedBy = [...new Set([...row.consumed_by, ...okKeys])];
    const retry = results.find((r) => r.status === "retry");
    const errors = results.filter((r) => r.status === "error");

    if (retry) {
      // Reagendamento benigno (ex. janela anti-ban): NÃO conta attempt — mesmo
      // que outro handler do mesmo tick tenha retornado erro (esse handler
      // nunca entrou em consumed_by, então ele reroda no próximo tick; aqui só
      // preservamos o last_error dele pra visibilidade/observabilidade).
      // retry_at é opcional no HandlerResult — sem ele, aplica o mesmo backoff
      // do branch de erro pra não busy-loop reprocessando a cada tick.
      const retryAt = retry.retry_at ?? backoffAt(row.attempts + 1);
      await admin
        .from("event_log")
        .update({
          status: "pending",
          consumed_by: consumedBy,
          next_attempt_at: retryAt,
          updated_at: new Date().toISOString(),
          ...(errors.length
            ? {
                last_error: errors
                  .map((e) => `${e.consumer_key}: ${e.detail ?? "error"}`)
                  .join("; "),
              }
            : {}),
        })
        .eq("id", row.id);
      summary.retried += 1;
    } else if (errors.length) {
      const attempts = row.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      await admin
        .from("event_log")
        .update({
          status: dead ? "dead" : "pending",
          attempts,
          consumed_by: consumedBy,
          last_error: errors.map((e) => `${e.consumer_key}: ${e.detail ?? "error"}`).join("; "),
          next_attempt_at: dead ? null : backoffAt(attempts),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      summary[dead ? "dead" : "failed"] += 1;
      if (dead) {
        await avisarEventoMorto(
          admin,
          row,
          errors.map((e) => `${e.consumer_key}: ${e.detail ?? "error"}`).join("; "),
        );
      }
    } else {
      // O MOTIVO DE UM `skipped` SOBREVIVE À LINHA.
      //
      // `skipped` conta como sucesso — e deve mesmo: o handler decidiu que não
      // era caso dele. Mas o `detail` era DESCARTADO por construção, e com ele
      // a única evidência de por que um evento não fez nada. Quem investigasse
      // "subi o material e não aconteceu nada" encontrava uma linha `done` sem
      // uma palavra de explicação.
      //
      // Não muda o desfecho do evento; só deixa de jogar fora a resposta.
      const pulados = results.filter((r) => r.status === "skipped" && r.detail);
      // E o motivo sai também no RESUMO, não só na linha.
      //
      // A linha basta para quem tem psql; não basta para o CI, onde o único
      // artefato que sobrevive ao job é o trace — e o trace guarda o CORPO da
      // resposta HTTP. Um e2e que morre porque o gatilho pulou ficava sem poder
      // dizer QUAL pulo foi: travou por horas o diagnóstico de
      // `gatilho-de-etapa.spec.ts`, com `failed=0` e nenhuma pista.
      if (pulados.length)
        summary.pulados?.push(
          ...pulados.map((r) => `${row.event_type}/${r.consumer_key}: ${r.detail}`),
        );
      await admin
        .from("event_log")
        .update({
          status: "done",
          consumed_by: consumedBy,
          updated_at: new Date().toISOString(),
          ...(pulados.length
            ? { last_error: pulados.map((r) => `${r.consumer_key}: ${r.detail}`).join("; ") }
            : {}),
        })
        .eq("id", row.id);
      summary.done += 1;
    }
  }
  return summary;
}
