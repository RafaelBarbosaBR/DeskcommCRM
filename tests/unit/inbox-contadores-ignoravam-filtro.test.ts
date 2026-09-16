/**
 * OS CONTADORES DAS ABAS DO INBOX IGNORAVAM OS FILTROS; "FECHADAS" NÃO TINHA NÚMERO.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * `GET /api/v1/conversations/counts` sempre contava a ORGANIZAÇÃO INTEIRA —
 * `tag`, `channel_session_id` e `onlyUnread`, que a listagem já aplicava
 * (`_handler.ts`), nunca chegavam às consultas de contagem. Com um canal ou
 * uma tag escolhidos, o badge da aba mostrava um número maior que a lista
 * embaixo dele — o atendente via "Fila 12" e contava 3 linhas.
 *
 * E a aba "Fechadas" nunca teve `Promise.all` nenhum calculando o dela: o
 * `tabToFilter("closed")` sempre existiu, o badge para ela nunca existiu.
 *
 * O teste é da ROTA (`GET`), não de uma função isolada — o defeito era a
 * leitura de `searchParams` nunca acontecer, exatamente como
 * `inbox-filtro-de-tag.test.ts` documenta para a listagem.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => stub,
}));
vi.mock("@/lib/auth/server", () => ({
  mfaEmDivida: vi.fn(async () => false),
  loadAuthUser: async () => ({ id: "u-1", idioma: "pt-BR" }),
  resolveActiveOrg: async () => ({ orgId: "org-1", role: "agent" }),
}));

interface Chamada {
  tabela: string;
  metodo: string;
  args: unknown[];
}

let chamadas: Chamada[] = [];

/** Dublê que registra a cadeia por tabela — `conversations` (contagens) e
 *  `ai_agents` (a pergunta ORG-WIDE de `orgTemAutomatico`, que a rota faz
 *  antes de montar o `Promise.all`). */
function fakeFrom(tabela: string) {
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (ok: (v: unknown) => unknown) =>
            ok(
              tabela === "ai_agents"
                ? { data: [], error: null }
                : { count: 3, error: null },
            );
        }
        return (...args: unknown[]) => {
          chamadas.push({ tabela, metodo: String(prop), args });
          return proxy;
        };
      },
    },
  );
  return proxy;
}

const stub = {
  auth: { getUser: async () => ({ data: { user: { id: "u-1" } }, error: null }) },
  from: (tabela: string) => fakeFrom(tabela),
};

beforeEach(() => {
  chamadas = [];
  vi.clearAllMocks();
});

/** Todas as chamadas feitas na tabela `conversations`. */
const emConversations = () => chamadas.filter((c) => c.tabela === "conversations");

async function contar(qs: string) {
  const { GET } = await import("@/app/api/v1/conversations/counts/route");
  const res = await GET(new NextRequest(`http://x/api/v1/conversations/counts${qs}`));
  return { res, body: (await res.json()) as { data: Record<string, number> } };
}

describe("GET /api/v1/conversations/counts — os filtros chegam às 5 contagens", () => {
  it("⭐ sem filtro nenhum, nenhuma contagem ganha channel_session_id/tag/only_unread", async () => {
    await contar("");
    const conv = emConversations();
    expect(conv.some((c) => c.metodo === "contains")).toBe(false);
    expect(conv.some((c) => c.metodo === "gt" && c.args[0] === "unread_count_for_assignee")).toBe(
      false,
    );
    expect(
      conv.some((c) => c.metodo === "eq" && c.args[0] === "channel_session_id"),
    ).toBe(false);
  });

  it("?tag=vip aplica contains(tags,[vip]) nas 5 contagens (fila/automatico/mine/all/closed)", async () => {
    await contar("?tag=vip");
    const porTag = emConversations().filter(
      (c) => c.metodo === "contains" && c.args[0] === "tags",
    );
    // Uma por countExact(): fila, automatico, mine, all, closed.
    expect(porTag).toHaveLength(5);
    for (const c of porTag) expect(c.args[1]).toEqual(["vip"]);
  });

  it("?channel_session_id=<id> aplica eq(channel_session_id,<id>) nas 5 contagens", async () => {
    const id = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
    await contar(`?channel_session_id=${id}`);
    const porCanal = emConversations().filter(
      (c) => c.metodo === "eq" && c.args[0] === "channel_session_id" && c.args[1] === id,
    );
    expect(porCanal).toHaveLength(5);
  });

  it("?only_unread=true aplica gt(unread_count_for_assignee,0) nas 5 contagens", async () => {
    await contar("?only_unread=true");
    const porNaoLido = emConversations().filter(
      (c) => c.metodo === "gt" && c.args[0] === "unread_count_for_assignee" && c.args[1] === 0,
    );
    expect(porNaoLido).toHaveLength(5);
  });

  it("only_unread=false (ou ausente) não filtra nenhuma contagem", async () => {
    await contar("?only_unread=false");
    const porNaoLido = emConversations().filter(
      (c) => c.metodo === "gt" && c.args[0] === "unread_count_for_assignee",
    );
    expect(porNaoLido).toHaveLength(0);
  });
});

describe("GET /api/v1/conversations/counts — a aba Fechadas ganha número", () => {
  it("⭐ a resposta tem o campo closed, contado por status='closed'", async () => {
    const { body } = await contar("");
    expect(body.data.closed).toBe(3);

    const porClosed = emConversations().filter(
      (c) => c.metodo === "eq" && c.args[0] === "status" && c.args[1] === "closed",
    );
    expect(
      porClosed.length,
      "nenhuma contagem pediu status='closed' — a aba Fechadas segue sem número",
    ).toBeGreaterThan(0);
  });

  it("os outros campos continuam respondendo (fila/automatico/unassigned/mine/all)", async () => {
    const { body } = await contar("");
    for (const campo of ["fila", "automatico", "unassigned", "mine", "all"]) {
      expect(body.data[campo], `campo ${campo} sumiu da resposta`).toBe(3);
    }
  });
});
