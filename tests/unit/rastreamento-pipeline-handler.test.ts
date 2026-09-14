/**
 * A fronteira mais importante do motor de rastreamento: nunca reportar a
 * mesma venda duas vezes pra Meta (uma pelo pipeline legado de CTWA, outra
 * por este). A condição de entrada é sempre `contacts.visitor_id is not
 * null` — sem isso, o handler nem tenta.
 */
import { describe, expect, it, vi } from "vitest";

import { pipelineDeRastreamentoHandler } from "@/lib/rastreamento/motor/pipeline.handler";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG = "11111111-1111-1111-1111-111111111111";
const LEAD = "22222222-2222-2222-2222-222222222222";
const CONTATO = "33333333-3333-3333-3333-333333333333";

interface Tabelas {
  crm_leads?: unknown;
  contacts?: unknown;
  crm_stages?: unknown;
  touchpoints?: unknown;
  internal_events?: unknown;
}

const inserts: { tabela: string; valores: Record<string, unknown> }[] = [];

function fakeAdmin(tabelas: Tabelas) {
  return {
    from(tabela: string) {
      const construtor = {
        select: () => construtor,
        eq: () => construtor,
        order: () => construtor,
        limit: () => construtor,
        insert: (valores: Record<string, unknown>) => {
          inserts.push({ tabela, valores });
          return {
            select: () => ({
              maybeSingle: async () => ({ data: { id: "evt-novo" }, error: null }),
            }),
          };
        },
        maybeSingle: async () => ({
          data: (tabelas as Record<string, unknown>)[tabela] ?? null,
          error: null,
        }),
      };
      return construtor;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

const leadGanho = {
  id: LEAD,
  organization_id: ORG,
  status: "won",
  contact_id: CONTATO,
  stage_id: "stage-1",
  value_cents: 100_00,
  currency: "BRL",
  closed_at: new Date().toISOString(),
};

function evento(tipo: string): EventRow {
  return {
    id: "evt",
    organization_id: ORG,
    event_type: tipo,
    entity_kind: "crm_lead",
    entity_id: LEAD,
    payload: {},
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: new Date().toISOString(),
  };
}

describe("fronteira: sem visitor_id, o motor novo nunca age", () => {
  it("contato sem visitor_id (ex.: veio de CTWA) é ignorado — o pipeline legado é quem cuida dele", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({ crm_leads: leadGanho, contacts: { visitor_id: null } }) as never,
    );
    inserts.length = 0;

    const r = await pipelineDeRastreamentoHandler.handle(evento("lead.won"));

    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("sem_visitor_id");
    expect(inserts).toHaveLength(0);
  });

  it("lead sem contato nenhum é ignorado", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({ crm_leads: { ...leadGanho, contact_id: null } }) as never,
    );
    inserts.length = 0;

    const r = await pipelineDeRastreamentoHandler.handle(evento("lead.won"));

    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("sem_contato");
  });
});

describe("com visitor_id, o motor novo registra PURCHASE no fechamento", () => {
  it("lead.won com contato rastreado gera o evento PURCHASE", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({ crm_leads: leadGanho, contacts: { visitor_id: "visitor-row-id" } }) as never,
    );
    inserts.length = 0;

    const r = await pipelineDeRastreamentoHandler.handle(evento("lead.won"));

    expect(r.status).toBe("ok");
    const insertDeEvento = inserts.find((i) => i.tabela === "internal_events");
    expect(insertDeEvento?.valores).toMatchObject({ event_type: "PURCHASE", lead_id: LEAD });
  });

  it("lead aberto (não ganho) não gera PURCHASE", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        crm_leads: { ...leadGanho, status: "open" },
        contacts: { visitor_id: "visitor-row-id" },
      }) as never,
    );
    inserts.length = 0;

    const r = await pipelineDeRastreamentoHandler.handle(evento("lead.won"));

    expect(r.status).toBe("skipped");
    expect(inserts.find((i) => i.tabela === "internal_events")).toBeUndefined();
  });
});
