import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/v1/admin/tenants/[id] — cabeçalho do tenant no painel de plataforma.
 *
 * O contador de LGPD filtrava `status = 'pending'`, valor que não existe em
 * `lgpd_requests_status_check` (received/processing/completed/failed/expired):
 * era sempre 0, e a tela jurava que o tenant não devia nada à LGPD.
 *
 * O dublê abaixo aplica o filtro sobre linhas com status do vocabulário REAL —
 * é isso que faz o teste reprovar um predicado que compara com valor imaginado.
 */

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({
  requirePlatformAdmin: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

const ORG = {
  id: ORG_ID,
  slug: "org",
  display_name: "Org",
  legal_name: null,
  cnpj: null,
  status: "active",
  onboarded_at: "2026-01-01T00:00:00Z",
  suspended_at: null,
  created_at: "2026-01-01T00:00:00Z",
  settings: {},
};

/** Linhas de lgpd_requests com status do vocabulário real do CHECK. */
const LGPD_ROWS = [
  { status: "received" },
  { status: "processing" },
  { status: "completed" },
  { status: "failed" },
];

type Filtro =
  | { kind: "eq"; col: string; val: unknown }
  | { kind: "not_in"; col: string; vals: string[] };

function lgpdBuilder() {
  const filtros: Filtro[] = [];
  const builder = {
    select: () => builder,
    eq: (col: string, val: unknown) => {
      filtros.push({ kind: "eq", col, val });
      return builder;
    },
    not: (col: string, op: string, list: string) => {
      if (op !== "in") throw new Error(`operador não simulado: ${op}`);
      filtros.push({
        kind: "not_in",
        col,
        vals: list.replace(/^\(|\)$/g, "").split(","),
      });
      return builder;
    },
    then(resolve: (v: { count: number; error: null }) => unknown) {
      const count = LGPD_ROWS.filter((row) =>
        filtros.every((f) => {
          if (f.col === "organization_id") return true;
          if (f.kind === "eq") return row.status === f.val;
          return !f.vals.includes(row.status);
        }),
      ).length;
      return Promise.resolve({ count, error: null }).then(resolve);
    },
  };
  return builder;
}

function contadorVazio() {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "is", "not", "limit", "order"]) {
    builder[m] = () => builder;
  }
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ count: 0, data: [], error: null }).then(resolve);
  builder.single = async () => ({ data: ORG, error: null });
  return builder;
}

/** `ai_agents`/`ai_agent_versions` — builder simples que devolve as linhas passadas. */
function tabelaComLinhas(linhas: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "order", "in"]) {
    builder[m] = () => builder;
  }
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: linhas, error: null }).then(resolve);
  return builder;
}

function makeAdminStub(opts: { agents?: unknown[]; versions?: unknown[] } = {}) {
  return {
    from: (table: string) => {
      if (table === "lgpd_requests") return lgpdBuilder();
      if (table === "ai_agents") return tabelaComLinhas(opts.agents ?? []);
      if (table === "ai_agent_versions") return tabelaComLinhas(opts.versions ?? []);
      return contadorVazio();
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePlatformAdmin).mockResolvedValue({
    user: { id: ADMIN_ID },
    platformAdmin: { user_id: ADMIN_ID, scope: "full", mfa_required: true },
  } as never);
  vi.mocked(createAdminClient).mockReturnValue(makeAdminStub() as never);
});

describe("GET /api/v1/admin/tenants/[id]", () => {
  it("conta como pendente o que o banco realmente grava (received/processing)", async () => {
    const { GET } = await import("./route");
    const res = await GET(
      new NextRequest(`http://localhost/api/v1/admin/tenants/${ORG_ID}`),
      { params: Promise.resolve({ id: ORG_ID }) },
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { counts: { lgpd_requests_pending: number } };
    };
    expect(body.data.counts.lgpd_requests_pending).toBe(2);
  });
});

/**
 * `agents` — qual agente está publicado por tenant, e com qual modelo.
 *
 * Antes o painel de plataforma não sabia responder "qual modelo esse cliente
 * está usando" sem uma consulta manual no banco. O modelo mostrado tem de ser
 * o da VERSÃO PUBLICADA (o que de fato responde), não o rascunho em
 * `ai_agents.model` — os dois podem divergir quando alguém edita sem publicar.
 */
describe("GET /api/v1/admin/tenants/[id] — agents", () => {
  it("⭐ agente publicado: status vem de estadoDoAgente, modelo vem da VERSÃO publicada", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub({
        agents: [
          {
            id: "agent-1",
            name: "SDR",
            kind: "mcp_agent",
            is_active: true,
            paused_at: null,
            archived_at: null,
            published_version_id: "v-1",
            model: "modelo-do-rascunho",
          },
        ],
        versions: [
          { id: "v-1", model: "modelo-publicado", version_number: 4, published_at: "2026-09-10T00:00:00Z" },
        ],
      }) as never,
    );

    const { GET } = await import("./route");
    const res = await GET(
      new NextRequest(`http://localhost/api/v1/admin/tenants/${ORG_ID}`),
      { params: Promise.resolve({ id: ORG_ID }) },
    );
    const body = (await res.json()) as {
      data: { agents: Array<{ status: string; model: string; version_number: number | null }> };
    };

    expect(body.data.agents).toHaveLength(1);
    expect(body.data.agents[0]?.status).toBe("no_ar");
    // Se a rota lesse `ai_agents.model` (o rascunho), este teste pegaria a
    // string errada — a mesma classe de bug que "modelo saiu pelo canal
    // errado" (item 3.8): a fonte parece certa e responde, só que não é a que
    // está em produção.
    expect(body.data.agents[0]?.model).toBe("modelo-publicado");
    expect(body.data.agents[0]?.version_number).toBe(4);
  });

  it("agente pausado (paused_at setado): status 'parado', mesmo com published_version_id", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub({
        agents: [
          {
            id: "agent-2",
            name: "Pausado",
            kind: "mcp_agent",
            is_active: true,
            paused_at: "2026-09-01T00:00:00Z",
            archived_at: null,
            published_version_id: "v-2",
            model: "modelo-do-rascunho",
          },
        ],
        versions: [{ id: "v-2", model: "x", version_number: 1, published_at: null }],
      }) as never,
    );

    const { GET } = await import("./route");
    const res = await GET(
      new NextRequest(`http://localhost/api/v1/admin/tenants/${ORG_ID}`),
      { params: Promise.resolve({ id: ORG_ID }) },
    );
    const body = (await res.json()) as { data: { agents: Array<{ status: string }> } };
    expect(body.data.agents[0]?.status).toBe("parado");
  });

  it("sem published_version_id: usa o modelo do rascunho, sem consultar ai_agent_versions", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub({
        agents: [
          {
            id: "agent-3",
            name: "Nunca publicado",
            kind: "rag_bot",
            is_active: false,
            paused_at: null,
            archived_at: null,
            published_version_id: null,
            model: "modelo-do-rascunho",
          },
        ],
      }) as never,
    );

    const { GET } = await import("./route");
    const res = await GET(
      new NextRequest(`http://localhost/api/v1/admin/tenants/${ORG_ID}`),
      { params: Promise.resolve({ id: ORG_ID }) },
    );
    const body = (await res.json()) as {
      data: { agents: Array<{ status: string; model: string; version_number: number | null }> };
    };
    expect(body.data.agents[0]?.status).toBe("parado");
    expect(body.data.agents[0]?.model).toBe("modelo-do-rascunho");
    expect(body.data.agents[0]?.version_number).toBeNull();
  });

  it("sem nenhum agente, devolve lista vazia (não quebra)", async () => {
    const { GET } = await import("./route");
    const res = await GET(
      new NextRequest(`http://localhost/api/v1/admin/tenants/${ORG_ID}`),
      { params: Promise.resolve({ id: ORG_ID }) },
    );
    const body = (await res.json()) as { data: { agents: unknown[] } };
    expect(body.data.agents).toEqual([]);
  });
});
