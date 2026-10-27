import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/v1/cron/agenda-google-sync/route";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";

vi.mock("@/lib/env", () => ({ env: { INTERNAL_CRON_SECRET: "cron" } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/agenda/google/membros", () => ({
  apenasDeMembrosAtivos: vi.fn(async (_db, rows) => rows),
}));
vi.mock("@/lib/agenda/google/sync-executor", () => ({
  tokenForConnection: vi.fn(async () => "token"),
  reconcileAppointment: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

// QUANTAS VEZES POR HORA UMA AGENDA PARADA CUSTA AO GOOGLE (PR #2866).
//
// O PR troca o cron da sincronização de 15 em 15 min para 1 em 1 min. O ok do
// dono veio com uma condição: medir as chamadas por hora numa agenda parada,
// antes e depois. Aqui a rota e o executor são os de produção; só o banco e o
// Google são dublês, e o relógio é simulado.
//
// O detalhe que decide o número é o atraso. A página final grava "próxima
// leitura em +15 min" DEPOIS da ida ao Google, então o prazo fica em
// T + atraso + 15 min. Com o passo de 15 min, o tick seguinte chega segundos
// antes desse prazo e a agenda só é lida no outro: a cada 30 min. Um dublê sem
// atraso daria 4 por hora e esconderia isso.
//
// O segundo caso é a falha do catálogo: só o sucesso grava `catalog_checked_at`,
// e sem recuo a rota tentaria de novo a cada tick.

const ENTRYPOINT = readFileSync(path.join(process.cwd(), "docker/scheduler/entrypoint.sh"), "utf8");

/** O passo em minutos do cron da sincronização, lido do crontab do scheduler. */
function passoDoCronDeSync(): number {
  const linha = ENTRYPOINT.split("\n").find((l) => l.includes("|api/v1/cron/agenda-google-sync"));
  const minuto = linha?.split("|")[0]?.trim().split(/\s+/)[0];
  if (minuto === "*") return 1;
  const passo = /^\*\/(\d+)$/.exec(minuto ?? "");
  if (!passo?.[1]) throw new Error(`cadência ilegível: ${linha}`);
  return Number(passo[1]);
}

const INICIO = Date.parse("2026-10-15T12:00:00.000Z");
/** Do minuto cheio até a rota ler o banco (agendador + HTTP interno). */
const ATRASO_DO_TICK_MS = 500;
/** Ida e volta ao Google. */
const ATRASO_DO_GOOGLE_MS = 1_500;
const HORAS = 4;
const QUINZE_MIN = 15 * 60_000;

type Cenario = { passo: number; catalogoFalha: boolean; catalogoVerificadoEm: number };

async function simular({ passo, catalogoFalha, catalogoVerificadoEm }: Cenario) {
  const conexao: Record<string, unknown> = {
    id: "aaaaaaaa-0000-4000-8000-000000000003",
    organization_id: "aaaaaaaa-0000-4000-8000-000000000001",
    user_id: "aaaaaaaa-0000-4000-8000-000000000009",
    calendar_selection_revision: "1",
    catalog_retry_at: null,
  };
  const agenda = {
    id: "aaaaaaaa-0000-4000-8000-000000000002",
    external_calendar_id: "agenda",
    counts_for_conflicts: true,
    is_destination: true,
    sync_next_attempt_at: INICIO,
    catalog_checked_at: catalogoVerificadoEm,
    sync_token: null as string | null,
    sync_cursor: null as Record<string, unknown> | null,
  };
  const claim = () => ({
    token: "aaaaaaaa-0000-4000-8000-000000000004",
    epoch: "1",
    lease_until: new Date(Date.now() + 90_000).toISOString(),
  });
  const snapshot = () => ({
    id: agenda.id,
    organization_id: conexao.organization_id,
    connection_id: conexao.id,
    external_calendar_id: agenda.external_calendar_id,
    time_zone: "America/Sao_Paulo",
    claim: claim(),
    sync_cursor: agenda.sync_cursor,
  });
  const db = {
    rpc: async (name: string, p: Record<string, unknown>) => {
      if (name === "fn_google_calendar") {
        if (p.p_action === "claim") {
          agenda.sync_cursor ??= {
            generation: "aaaaaaaa-0000-4000-8000-000000000005",
            mode: agenda.sync_token ? "incremental" : "full",
            base_sync_token: agenda.sync_token,
            page_token: null,
            window_start: new Date(Date.now() - 86_400_000).toISOString(),
            window_end: new Date(Date.now() + 90 * 86_400_000).toISOString(),
          };
          return { data: snapshot(), error: null };
        }
        if (p.p_action === "error") agenda.sync_next_attempt_at = Date.now() + QUINZE_MIN;
        return { data: p.p_action === "renew" ? snapshot() : true, error: null };
      }
      if (name === "fn_google_calendar_page_batch") {
        // Como a RPC real: now() é o início da transação, que começa DEPOIS da
        // ida ao Google — o relógio já andou o atraso.
        const args = p.p_args as { next_page_token: string | null; next_sync_token: string | null };
        if (args.next_page_token) {
          agenda.sync_cursor = { ...agenda.sync_cursor, page_token: args.next_page_token };
          agenda.sync_next_attempt_at = Date.now();
        } else {
          agenda.sync_token = args.next_sync_token;
          agenda.sync_cursor = null;
          agenda.sync_next_attempt_at = Date.now() + QUINZE_MIN;
        }
        return { data: snapshot(), error: null };
      }
      if (name === "fn_google_catalog") {
        agenda.catalog_checked_at = Date.now();
        agenda.sync_next_attempt_at = Date.now();
        return { data: null, error: null };
      }
      throw new Error(`rpc inesperada: ${name}`);
    },
    from: (table: string) => {
      let projecao = "";
      let patch: Record<string, unknown> | null = null;
      let ate = Number.POSITIVE_INFINITY;
      const executar = () => {
        if (table === "calendar_connections") {
          if (patch) Object.assign(conexao, patch);
          if (projecao.startsWith("calendar_selection_revision"))
            return { data: { calendar_selection_revision: "1" }, error: null };
          return { data: patch ? null : [{ ...conexao }], error: null };
        }
        if (table === "calendar_connection_calendars") {
          if (patch) return { data: null, error: null };
          if (projecao === "catalog_checked_at")
            return { data: [{ catalog_checked_at: new Date(agenda.catalog_checked_at).toISOString() }], error: null };
          return { data: agenda.sync_next_attempt_at <= ate ? [{ ...agenda }] : [], error: null };
        }
        throw new Error(`tabela inesperada: ${table}`);
      };
      const q = {
        select: (s: string) => ((projecao = s), q),
        eq: () => q,
        order: () => q,
        lte: (_k: string, v: string) => ((ate = Date.parse(v)), q),
        update: (p: Record<string, unknown>) => ((patch = p), q),
        limit: async () => executar(),
        single: async () => executar(),
        then: (resolve: (value: unknown) => void) => resolve(executar()),
      };
      return q;
    },
  };
  vi.mocked(createAdminClient).mockReturnValue(db as never);

  const chamadas = { eventos: 0, catalogo: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      vi.setSystemTime(Date.now() + ATRASO_DO_GOOGLE_MS);
      if (url.includes("/calendarList")) {
        chamadas.catalogo += 1;
        if (catalogoFalha) return new Response("{}", { status: 429 });
        return new Response(JSON.stringify({ items: [] }));
      }
      if (url.includes("/events")) {
        chamadas.eventos += 1;
        return new Response(JSON.stringify({ items: [], nextSyncToken: `t${chamadas.eventos}` }));
      }
      throw new Error(`url inesperada: ${url}`);
    }),
  );

  for (let minuto = 0; minuto < HORAS * 60; minuto += passo) {
    vi.setSystemTime(INICIO + minuto * 60_000 + ATRASO_DO_TICK_MS);
    const res = await GET(
      new NextRequest("http://local/cron", { headers: { authorization: "Bearer cron" } }),
    );
    expect(res.status).toBe(200);
  }
  return {
    eventosPorHora: chamadas.eventos / HORAS,
    catalogoPorHora: chamadas.catalogo / HORAS,
    auditsPorHora: vi.mocked(audit).mock.calls.length / HORAS,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("cota do Google por hora numa agenda parada", () => {
  const catalogoRecente = INICIO - 3_600_000;

  it("CONTROLE: com o passo de 15 min da main, o atraso faz a agenda ser lida a cada 30 min", async () => {
    // Se o dublê não reproduzisse o atraso, aqui sairia 4 e o caso de baixo
    // mediria um mundo que não existe.
    const antes = await simular({ passo: 15, catalogoFalha: false, catalogoVerificadoEm: catalogoRecente });
    expect(antes.eventosPorHora).toBe(2);
  });

  it("com o passo do crontab, a agenda parada não passa de 4 leituras por hora (o desenho de 15 min)", async () => {
    const depois = await simular({
      passo: passoDoCronDeSync(),
      catalogoFalha: false,
      catalogoVerificadoEm: catalogoRecente,
    });
    expect(depois.eventosPorHora, `medido: ${depois.eventosPorHora}/h`).toBeLessThanOrEqual(4);
    expect(depois.catalogoPorHora).toBe(0);
  });

  it("catálogo que falha espera 15 min para tentar de novo, e não audita a cada tick", async () => {
    const doisDiasAtras = INICIO - 2 * 86_400_000;
    const depois = await simular({
      passo: passoDoCronDeSync(),
      catalogoFalha: true,
      catalogoVerificadoEm: doisDiasAtras,
    });
    expect(depois.catalogoPorHora, `medido: ${depois.catalogoPorHora}/h`).toBeLessThanOrEqual(4);
    expect(depois.auditsPorHora, `medido: ${depois.auditsPorHora}/h`).toBeLessThanOrEqual(4);
    // Com o catálogo vencido e falhando, as agendas não são lidas — como antes.
    expect(depois.eventosPorHora).toBe(0);
  });
});
