import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TRECHO QUE NÃO GRAVOU NÃO PODE VIRAR VERSÃO ATIVA.
 *
 * Achado no changelog upstream (Onda 2, item 2.5): `indexarFonte` só falhava
 * a versão quando `gravados === 0` — falha PARCIAL (metade dos upserts em
 * `ai_chunks` deu erro, a outra metade gravou) ainda chamava
 * `markVersionReady` + `activateVersion`. O agente passava a responder com um
 * acervo incompleto, sem qualquer aviso além de um `console.warn` por trecho
 * perdido — ninguém lê o log do contêiner até o cliente reclamar.
 */

const embedText = vi.hoisted(() => vi.fn(async () => ({ embedding: [0.1, 0.2, 0.3] })));
vi.mock("@/lib/ai/embed", () => ({
  embedText,
  SemChaveDeEmbeddingError: class SemChaveDeEmbeddingError extends Error {},
}));

const createKnowledgeVersion = vi.hoisted(() =>
  vi.fn(async () => ({ versionId: "version-1", versionNumber: 1 })),
);
const markVersionReady = vi.hoisted(() => vi.fn(async () => undefined));
const markVersionFailed = vi.hoisted(() => vi.fn(async () => undefined));
const activateVersion = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/ai/rag/version", () => ({
  createKnowledgeVersion,
  markVersionReady,
  markVersionFailed,
  activateVersion,
}));

/** 2 itens de FAQ → 2 trechos (um por pergunta/resposta, curtos o bastante pra não fragmentar). */
const FAQ_ITEMS = [
  { question: "Vocês entregam em todo o Brasil?", answer: "Sim, entregamos para todo o território nacional." },
  { question: "Qual o prazo de troca?", answer: "Trinta dias corridos a partir do recebimento." },
];

function fakeAdmin(upsertErrorsNasPosicoes: Set<number>) {
  return {
    from: (table: string) => {
      if (table === "ai_faq_items") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: async () => ({ data: FAQ_ITEMS, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "ai_chunks") {
        return {
          upsert: (row: { position: number }) => ({
            then: (ok: (v: { error: { message: string } | null }) => unknown) =>
              Promise.resolve({
                error: upsertErrorsNasPosicoes.has(row.position)
                  ? { message: `falha simulada na posição ${row.position}` }
                  : null,
              }).then(ok),
          }),
        };
      }
      throw new Error(`tabela inesperada: ${table}`);
    },
  };
}

const createAdminClient = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));

const FONTE = {
  id: "fonte-1",
  organization_id: "org-1",
  agent_id: null,
  source_type: "faq",
  name: "FAQ da loja",
  status: "ready",
  is_active: true,
  source_metadata: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  createKnowledgeVersion.mockResolvedValue({ versionId: "version-1", versionNumber: 1 });
});

describe("indexarFonte — trecho que falha não pode virar versão ativa", () => {
  it("upsert falha num trecho, o outro grava: NÃO ativa, marca failed com a contagem", async () => {
    createAdminClient.mockReturnValue(fakeAdmin(new Set([1])));
    const { __test_indexarFonte } = await import("@/workers/rag-indexer");

    const resultado = await __test_indexarFonte(FONTE as never, {} as never, {});

    expect(resultado.tipo).toBe("erro");
    expect(markVersionFailed).toHaveBeenCalledWith(
      "version-1",
      "org-1",
      expect.stringContaining("trechos_nao_gravados"),
    );
    expect(markVersionReady).not.toHaveBeenCalled();
    expect(activateVersion).not.toHaveBeenCalled();
  });

  it("todos os upserts gravam: ativa normalmente (não regride o caminho feliz)", async () => {
    createAdminClient.mockReturnValue(fakeAdmin(new Set()));
    const { __test_indexarFonte } = await import("@/workers/rag-indexer");

    const resultado = await __test_indexarFonte(FONTE as never, {} as never, {});

    expect(resultado.tipo).toBe("ok");
    expect(markVersionReady).toHaveBeenCalledWith("version-1", "org-1", 2);
    expect(activateVersion).toHaveBeenCalledTimes(1);
    expect(markVersionFailed).not.toHaveBeenCalled();
  });

  it("todos os upserts falham: continua o caminho 'nenhum trecho gravado' de sempre", async () => {
    createAdminClient.mockReturnValue(fakeAdmin(new Set([0, 1])));
    const { __test_indexarFonte } = await import("@/workers/rag-indexer");

    const resultado = await __test_indexarFonte(FONTE as never, {} as never, {});

    expect(resultado).toMatchObject({ tipo: "erro", detalhe: "nenhum_trecho_gravado" });
    expect(activateVersion).not.toHaveBeenCalled();
  });
});
