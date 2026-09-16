/**
 * O FILTRO "NÃO LIDOS" DO INBOX PASSA A FILTRAR NO SERVIDOR, NÃO SÓ A PÁGINA JÁ CARREGADA.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * Antes, `onlyUnread` era filtro 100% client-side: `InboxLayout.tsx` recortava
 * só as páginas já buscadas (`ConversationList.tsx`'s `clientFilter`). Rolar a
 * lista com o filtro ligado nunca buscava mais conversas não lidas além das já
 * carregadas — o cursor de paginação corria sobre a lista INTEIRA, então
 * `fetchNextPage` podia trazer só conversas já lidas e a lista parecia
 * "acabar" mesmo havendo mais não lidas adiante.
 *
 * O conserto move o filtro para a query do servidor (`only_unread=true` →
 * `unread_count_for_assignee > 0`), igual aos outros filtros (`tag`,
 * `channel_session_id`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";

interface Chamada {
  tabela: string;
  metodo: string;
  args: unknown[];
}

function fakeSupabase() {
  const chamadas: Chamada[] = [];
  const client = {
    from: (tabela: string) => {
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
            }
            return (...args: unknown[]) => {
              chamadas.push({ tabela, metodo: String(prop), args });
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
  };
  return { client: client as never, chamadas };
}

const ctx = {
  organization_id: "org-1",
  requestId: "req-1",
  actor: { type: "user" as const, id: "user-1" },
} as never;

beforeEach(() => vi.clearAllMocks());

describe("only_unread — filtro de servidor sobre unread_count_for_assignee", () => {
  it("⭐ only_unread=true aplica gt(unread_count_for_assignee, 0) na query", async () => {
    const { client, chamadas } = fakeSupabase();
    await listConversationsHandler(client, ctx, { limit: 50, only_unread: true } as never);

    const chamadaGt = chamadas.find(
      (x) => x.tabela === "conversations" && x.metodo === "gt",
    );
    expect(
      chamadaGt,
      "only_unread=true não gerou nenhum .gt() na tabela conversations",
    ).toBeDefined();
    expect(chamadaGt?.args).toEqual(["unread_count_for_assignee", 0]);
  });

  it("sem only_unread, nenhum filtro de não-lidas é aplicado", async () => {
    const { client, chamadas } = fakeSupabase();
    await listConversationsHandler(client, ctx, { limit: 50 } as never);

    const chamadaGt = chamadas.find(
      (x) =>
        x.tabela === "conversations" &&
        x.metodo === "gt" &&
        x.args[0] === "unread_count_for_assignee",
    );
    expect(chamadaGt, "aplicou o filtro de não-lidas mesmo sem only_unread pedido").toBeUndefined();
  });

  it("only_unread=false (ausente/falsy) não filtra — só true ativa", async () => {
    const { client, chamadas } = fakeSupabase();
    await listConversationsHandler(client, ctx, { limit: 50, only_unread: false } as never);

    const chamadaGt = chamadas.find(
      (x) =>
        x.tabela === "conversations" &&
        x.metodo === "gt" &&
        x.args[0] === "unread_count_for_assignee",
    );
    expect(chamadaGt).toBeUndefined();
  });
});
