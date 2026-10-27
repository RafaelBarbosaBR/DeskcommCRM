import { describe, expect, it } from "vitest";

import { filtrosAuxiliaresDaContagem } from "@/app/api/v1/conversations/counts/route";
import { tabToFilter } from "@/components/inbox/InboxLayout";
import type { ConversationsFilters } from "@/hooks/inbox/useConversationsRealtime";
import { filtrosAuxiliaresAtivos } from "@/lib/inbox/filtros-ativos";

/**
 * Filtro por ATENDENTE do Inbox (gerente para cima). A lista pede `assigned_to`
 * à rota de conversas (que já o aceitava) e as contagens aplicam o MESMO filtro,
 * para o badge nunca contar o que a lista não mostra.
 */
const ATENDENTE = "bf49a9c8-9fbd-448c-8a94-4db4b14b7219";

describe("filtro por atendente — as contagens espelham a lista", () => {
  it("um id de usuário entra como igualdade em assigned_to_user_id", () => {
    const filtros = filtrosAuxiliaresDaContagem(new URLSearchParams({ assigned_to: ATENDENTE }));
    expect(filtros).toContainEqual(["assigned_to_user_id", ATENDENTE]);
  });

  it("junto com os outros filtros auxiliares", () => {
    const filtros = filtrosAuxiliaresDaContagem(
      new URLSearchParams({ assigned_to: ATENDENTE, channel_session_id: "canal-1" }),
    );
    expect(filtros).toContainEqual(["channel_session_id", "canal-1"]);
    expect(filtros).toContainEqual(["assigned_to_user_id", ATENDENTE]);
  });

  it("valor que não é id de usuário (me, unassigned, lixo) não vira filtro de coluna", () => {
    for (const v of ["me", "unassigned", "'; drop table x; --", ""]) {
      expect(
        filtrosAuxiliaresDaContagem(new URLSearchParams({ assigned_to: v })).some(
          ([coluna]) => coluna === "assigned_to_user_id",
        ),
      ).toBe(false);
    }
  });

  it("sem atendente escolhido nada muda", () => {
    expect(filtrosAuxiliaresDaContagem(new URLSearchParams())).toEqual([]);
  });
});

describe("filtro por atendente — a aba Minhas continua sendo só as minhas", () => {
  it("a aba Minhas traz assigned_to=me, que vence qualquer escolha", () => {
    expect(tabToFilter("mine").assigned_to).toBe("me");
  });

  it("as demais abas não impõem atendente: a escolha do gerente é que vale", () => {
    for (const aba of ["all", "closed", "archived", "unassigned", "ai"] as const) {
      expect(tabToFilter(aba).assigned_to).toBeUndefined();
    }
  });
});

describe("filtro por atendente — lista vazia diz que há filtro ligado", () => {
  it("o atendente escolhido é nomeado, e a lista vazia vira 'vazio por filtro'", () => {
    expect(filtrosAuxiliaresAtivos({ assigned_to: ATENDENTE } as ConversationsFilters)).toEqual(["Atendente"]);
  });

  it("a aba Minhas (`me`) não é filtro ligado por cima da aba", () => {
    expect(filtrosAuxiliaresAtivos({ assigned_to: "me" } as ConversationsFilters)).toEqual([]);
  });
});
