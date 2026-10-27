/**
 * #3103 — O PASSO DE IA ADIADO PELA JANELA ANTI-BAN AVISA O ENROLLMENT.
 *
 * ## O defeito
 *
 * Passo `action` sem texto fixo nem modelo (o agente escreve) enfileirado fora
 * da janela de disparo do canal: `runAgentTurn` reagendava o job para a
 * abertura e lançava `JobSettledError`, mas o enrollment não recebia o
 * `deferred`. O motor lia a espera como worker morto e o dead-man da ação
 * (~11h) marcava `dead` com `action_turn_never_completed` ANTES da abertura.
 * Medido em produção: janela 9h–18h (America/Recife), seis inscrições
 * enfileiradas às 21h02 morreram às 8h30, sem nenhum `action_deferred`.
 *
 * ## O que este arquivo prende
 *
 * 1. Fora da janela: o turno da IA NÃO roda, o job é reagendado para a
 *    abertura e o enrollment recebe `{ kind: 'deferred', until: abertura }`;
 * 2. Dentro da janela: o turno da IA roda como antes.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { JobRow } from "@/lib/agent-engine/queue/queue";

const ORG = "org-1";
const CONTATO = "contact-1";
const CONVERSA = "conversa-1";
const CANAL = "canal-1";

vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({ runBeforeSend: vi.fn() }));
vi.mock("@/lib/agent-engine/agent/human-handoff", () => ({ isLeadInHandoff: vi.fn(async () => false) }));
vi.mock("@/lib/agent-engine/edge/crm/get-lead-context", () => ({
  getLeadContext: vi.fn(async () => ({
    ok: true,
    context: { contact: { is_blocked: false } },
    lgpd: { isAnonymized: false, isProspecting: false, legalBasis: {} },
  })),
}));
const runAgentTurn = vi.fn(async () => undefined);
vi.mock("@/lib/agent-engine/agent/inbound-turn", async (original) => ({
  ...(await original<typeof import("@/lib/agent-engine/agent/inbound-turn")>()),
  runAgentTurn,
}));
vi.mock("@/lib/agent-engine/edge/crm/send-ledger", () => ({
  resultadoDoEnvioDoFollowup: vi.fn(async () => ({ kind: "sent" })),
}));

/** Canal com disparo 9h–18h, sem jitter (a abertura sai exata), org em Recife. */
const KNOBS = {
  throttle_ms: null,
  jitter_max_ms: 0,
  window_start_hour: 9,
  window_end_hour: 18,
  resposta_start_hour: 0,
  resposta_end_hour: 24,
  allow_sunday: true,
  prospeccao_dias: null,
  timezone: null,
  warmup_daily_caps: null,
  number_activated_at: null,
  org_timezone: "America/Recife",
};

function fakePool() {
  const sqls: string[] = [];
  const query = vi.fn(async (sql: string): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> => {
    sqls.push(sql);
    const r = (rows: Array<Record<string, unknown>>) => ({ rows, rowCount: rows.length });
    if (sql.includes("d.fechada_em::text")) {
      return r([
        {
          organization_id: ORG,
          contact_id: CONTATO,
          conversation_id: CONVERSA,
          service_revision: 1,
          demanda_id: null,
          demanda_revision: null,
          status: "open",
          demanda_fechada_em: null,
        },
      ]);
    }
    if (sql.includes("select current_node_id, status from followup_enrollments")) {
      return r([{ current_node_id: "passo", status: "active" }]);
    }
    if (sql.includes("left join channel_knobs")) return r([KNOBS]);
    if (/insert into cron_jobs/i.test(sql)) return r([{ id: "cron-1" }]);
    if (/from conversations/.test(sql)) {
      return r([{ id: CONVERSA, channel_session_id: CANAL, archived_at: null }]);
    }
    return r([]);
  });
  return { pool: { query } as never, sqls };
}

function job(): JobRow {
  return {
    id: "job-1",
    organization_id: ORG,
    contact_id: CONTATO,
    kind: "followup_turn",
    source_event_id: null,
    payload: {
      followup_enrollment_id: "11111111-1111-4111-8111-111111111111",
      node_id: "passo",
      purpose: "send_message",
      prompt_hint: "Retome a conversa no próximo dia útil.",
      service_boundary: {
        organization_id: ORG,
        contact_id: CONTATO,
        conversation_id: CONVERSA,
        service_revision: 1,
        demanda_id: null,
        demanda_revision: null,
      },
    },
    status: "running",
    priority: 0,
    run_after: new Date(),
    attempts: 1,
    max_attempts: 3,
    last_error: null,
    locked_by: "w1",
    locked_at: new Date(),
    created_at: new Date(),
  } as JobRow;
}

function deps(agora: Date) {
  const completeFollowupTurn = vi.fn(async (_pool: unknown, _input: Record<string, unknown>) => undefined);
  const d = {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    crmCfg: {},
    llmCfg: {},
    knobs: {},
    clock: () => agora,
    channel: () => ({ send: vi.fn() }),
    completeFollowupTurn,
  } as never;
  return { d, completeFollowupTurn };
}

describe("passo de IA do fluxo fora da janela anti-ban (#3103)", () => {
  let criarHandler: typeof import("@/lib/agent-engine/agent/followup-turn").createFollowupTurnHandler;

  beforeAll(async () => {
    ({ createFollowupTurnHandler: criarHandler } = await import("@/lib/agent-engine/agent/followup-turn"));
  }, 60_000);

  it("⭐ 21h02 em Recife (janela 9h–18h): não roda a IA, reagenda e devolve o adiamento ao enrollment", async () => {
    runAgentTurn.mockClear();
    const agora = new Date("2026-10-20T00:02:04.000Z"); // segunda 19/10, 21:02 em Recife
    const { d, completeFollowupTurn } = deps(agora);
    const { pool, sqls } = fakePool();

    await criarHandler(d)(job(), pool, { workerId: "w1" });

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(sqls.some((s) => /insert into cron_jobs/i.test(s)), "o job não foi reagendado para a abertura").toBe(true);
    expect(completeFollowupTurn).toHaveBeenCalledTimes(1);
    expect(completeFollowupTurn.mock.calls[0]![1]).toMatchObject({
      nodeId: "passo",
      result: { kind: "deferred", until: new Date("2026-10-20T12:00:00.000Z"), reason: "outside_window" },
    });
  });

  it("dentro da janela (10h em Recife) o turno da IA roda como antes", async () => {
    runAgentTurn.mockClear();
    const agora = new Date("2026-10-20T13:00:00.000Z");
    const { d, completeFollowupTurn } = deps(agora);
    const { pool } = fakePool();

    await criarHandler(d)(job(), pool, { workerId: "w1" });

    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(completeFollowupTurn.mock.calls[0]![1]).toMatchObject({ result: { kind: "sent" } });
  });
});
