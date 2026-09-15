import { describe, expect, it, vi } from "vitest";

import { crmSearchProducts } from "@/lib/mcp/tools/comercio";

/**
 * A MENSAGEM DE VARREDURA PARCIAL NÃO PODE DIZER "TEM null PRODUTOS".
 *
 * `total` é `number | null` — fica `null` quando o Postgrest não manda o
 * cabeçalho `Content-Range` (proxy, gateway, versão), o que é INDEPENDENTE de
 * a varredura ter sido parcial (a parada por página vazia não depende de
 * `count`). Antes do fix, template string interpolava `total` cru: um agente
 * de IA lia literalmente "...e o catálogo desta loja tem null." para o
 * cliente.
 */

vi.mock("@/lib/catalogo/busca", () => ({
  buscarComRelaxamento: vi.fn(() => ({ achados: [], ignorados: [] })),
}));

const LINHA = {
  id: "prod-1",
  codigo: "C1",
  nome: "Produto genérico",
  descricao: null,
  marca: null,
  categoria: null,
  preco_cents: 1000,
  moeda: "BRL",
  controla_estoque: false,
  quantidade: 0,
  ativo: true,
};

/**
 * Simula um Postgrest que NUNCA manda `count` (proxy que estripa
 * `Content-Range`) e tem páginas cheias o bastante para estourar
 * `PAGINAS_MAXIMAS` (10 × 1000) sem nunca devolver página vazia — a única
 * forma de a varredura terminar "parcial" com `total` ainda `null`.
 */
function fakeSupabaseSemCount() {
  let chamada = 0;
  const builder = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    range: async () => {
      chamada++;
      // 10 páginas cheias (nunca vazia) — bate o teto sem `alcancouOFim`.
      const lote = chamada <= 10 ? Array.from({ length: 1000 }, () => ({ ...LINHA })) : [];
      return { data: lote, error: null, count: null as number | null };
    },
  };
  return { from: () => builder };
}

const ctx = { supabase: fakeSupabaseSemCount(), organizationId: "org-1" } as never;

describe("busca de catálogo com varredura parcial e total desconhecido", () => {
  it("a mensagem não interpola null — diz que não conseguiu confirmar o total", async () => {
    const resultado = await crmSearchProducts.handler(
      { termo: "produto que não existe", limite: 8, somente_disponiveis: true },
      ctx,
    );

    expect(resultado.mensagem).not.toMatch(/tem null\b/);
    expect(resultado.mensagem).toContain("não consegui confirmar");
  });
});
