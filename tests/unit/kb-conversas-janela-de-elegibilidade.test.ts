// @vitest-environment node
/**
 * A JANELA DO LOTE É O MOMENTO DA ELEGIBILIDADE, NÃO O DA MARCAÇÃO (#3044).
 *
 * O lote diário só pegava `usable_for_rag_marked_at` dentro de 24 h. Com o
 * botão de "exemplo para a IA" na lista de conversas (#3042), marcar uma
 * conversa ABERTA passou a ser o caso comum — e resolvê-la mais de 24 h depois
 * deixava o selo nela e **nenhum lote a pegava nunca**.
 *
 * Este arquivo roda o LOTE de verdade (`ingestConversationsBatch`) sobre um
 * banco falso com a semântica dos filtros do PostgREST, e fixa as duas ordens:
 *
 *   ⭐ marcada há 25 h, resolvida AGORA  → tem de entrar (é o caso da issue);
 *   ⭐ marcada AGORA, resolvida há 25 h  → continua entrando (já funcionava);
 *   - marcada há 25 h e resolvida há 25 h → fica de fora (fora da janela);
 *   - `ingested` não volta, e `open` não entra.
 *
 * Com a janela antiga (só `usable_for_rag_marked_at`), o caso ⭐ falha: a
 * conversa nunca chega ao banco de chunks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  banco: { atual: null as unknown },
  embedText: vi.fn(),
  resolverChave: vi.fn(),
  criarVersao: vi.fn(),
  marcarPronta: vi.fn(),
  ativar: vi.fn(),
  marcarFalha: vi.fn(),
  perfil: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => deps.banco.atual }));
vi.mock("@/lib/ai/embed", () => ({ embedText: deps.embedText }));
vi.mock("@/lib/ai/embeddings/chave", () => ({
  resolverChaveDeEmbedding: deps.resolverChave,
  modeloDeEmbedding: () => "text-embedding-3-small",
}));
vi.mock("@/lib/ai/rag/version", () => ({
  createKnowledgeVersion: deps.criarVersao,
  markVersionReady: deps.marcarPronta,
  activateVersion: deps.ativar,
  markVersionFailed: deps.marcarFalha,
}));
vi.mock("@/lib/legal/perfil-do-pais", () => ({ perfilDaOrganizacao: deps.perfil }));
vi.mock("@/lib/ai/anonymize", () => ({
  anonymize: (texto: string) => ({ anonymized: texto, hits: [] }),
  detectResidualPii: () => null,
  padroesDaIngestao: () => ({}),
}));

import { ingestConversationsBatch } from "@/lib/ai/rag/ingest/conversations";

const ORG = "11111111-1111-4111-8111-111111111111";
const AGENTE = "22222222-2222-4222-8222-222222222222";

type Linha = Record<string, unknown>;

const horasAtras = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

/**
 * Banco falso com a semântica dos filtros que o PostgREST aplica na consulta do
 * lote: `eq`, `gt`, `is`, `in`, `or(termo,termo)` (cada termo é
 * `coluna.op.valor`) e `limit`. As fixtures são a única fonte de verdade; o
 * update de `rag_review_status` e os upserts de `ai_chunks` ficam visíveis no
 * estado para as asserções.
 */
function criarBancoFalso(conversas: Linha[], mensagens: Linha[]) {
  const estado = {
    conversas: conversas.map((c) => ({ ...c })),
    chunks: [] as Linha[],
  };

  const avaliarTermo = (linha: Linha, termo: string): boolean => {
    const m = /^([a-z_]+)\.([a-z]+)\.(.+)$/.exec(termo.trim());
    if (!m) throw new Error(`termo nao suportado no banco falso: ${termo}`);
    const [, col = "", op = "", valor = ""] = m;
    const v = linha[col];
    if (op === "gt") return v != null && String(v) > valor;
    if (op === "lt") return v != null && String(v) < valor;
    throw new Error(`op nao suportada no banco falso: ${op}`);
  };

  type Pred = (l: Linha) => boolean;

  class Cadeia {
    ops: Pred[] = [];
    payload: Linha | null = null;
    limite: number | null = null;
    private tabela: string;

    constructor(tabela: string) {
      this.tabela = tabela;
    }

    eq(col: string, val: unknown) {
      this.ops.push((l) => l[col] === val);
      return this;
    }
    gt(col: string, val: string) {
      this.ops.push((l) => l[col] != null && String(l[col]) > val);
      return this;
    }
    is(col: string, val: unknown) {
      this.ops.push((l) => l[col] === val);
      return this;
    }
    in(col: string, vals: readonly unknown[]) {
      const set = new Set(vals);
      this.ops.push((l) => set.has(l[col]));
      return this;
    }
    or(expr: string) {
      const termos = expr.split(",");
      this.ops.push((l) => termos.some((t) => avaliarTermo(l, t)));
      return this;
    }
    order() {
      return this;
    }
    limit(n: number) {
      this.limite = n;
      return this;
    }
    select() {
      return this;
    }
    update(payload: Linha) {
      this.payload = payload;
      return this;
    }
    private linhas(): Linha[] {
      const base =
        this.tabela === "conversations"
          ? estado.conversas
          : this.tabela === "messages"
            ? mensagens
            : this.tabela === "ai_knowledge_sources"
              ? [{ id: "fonte-1", organization_id: ORG, source_type: "conversas", is_active: true }]
              : [];
      const filtradas = base.filter((l) => this.ops.every((f) => f(l)));
      return this.limite == null ? filtradas : filtradas.slice(0, this.limite);
    }
    private executar(): { data: Linha[]; error: null } {
      const casadas = this.linhas();
      if (this.payload) for (const l of casadas) Object.assign(l, this.payload);
      return { data: casadas, error: null };
    }
    maybeSingle() {
      return { data: this.linhas()[0] ?? null, error: null };
    }
    single() {
      return { data: this.linhas()[0] ?? null, error: null };
    }
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(this.executar()).then(resolve, reject);
    }
  }

  const admin = {
    from(tabela: string) {
      if (tabela === "ai_chunks") {
        return {
          upsert: async (payload: Linha) => {
            estado.chunks.push(payload);
            return { error: null };
          },
        };
      }
      return new Cadeia(tabela);
    },
  };

  return { admin, estado };
}

const conversa = (id: string, extra: Linha = {}): Linha => ({
  id,
  organization_id: ORG,
  contact_id: `contato-${id}`,
  usable_for_rag: true,
  status: "resolved",
  rag_review_status: null,
  ...extra,
});

const mensagensDe = (conversationId: string): Linha[] => [
  { conversation_id: conversationId, organization_id: ORG, body: "Oi, tudo bem?", direction: "inbound", sent_at: horasAtras(27) },
  { conversation_id: conversationId, organization_id: ORG, body: "Tudo e voce?", direction: "outbound", sent_at: horasAtras(26) },
];

beforeEach(() => {
  vi.clearAllMocks();
  deps.embedText.mockImplementation(async () => ({ embedding: [0.1, 0.2] }));
  deps.resolverChave.mockImplementation(async () => ({ provedor: "openai" }));
  deps.criarVersao.mockImplementation(async () => ({ versionId: "versao-1" }));
  deps.marcarPronta.mockImplementation(async () => undefined);
  deps.ativar.mockImplementation(async () => undefined);
  deps.marcarFalha.mockImplementation(async () => undefined);
  deps.perfil.mockImplementation(async () => ({ codigo: "BR" }));
});

const rodarLote = () =>
  ingestConversationsBatch({ organizationId: ORG, agentId: AGENTE, sinceTs: new Date(Date.now() - 24 * 60 * 60 * 1000) });

describe("a janela do lote é o momento da elegibilidade (#3044)", () => {
  it("⭐ marcada há 25 h e resolvida AGORA entra no lote", async () => {
    const { admin, estado } = criarBancoFalso(
      [conversa("cA", { usable_for_rag_marked_at: horasAtras(25), status_changed_at: horasAtras(1) })],
      mensagensDe("cA"),
    );
    deps.banco.atual = admin;

    const r = await rodarLote();

    expect(r.processed).toBe(1);
    expect(estado.conversas[0]!.rag_review_status).toBe("ingested");
    expect(estado.chunks.map((c) => (c.metadata as Linha).conversation_id)).toEqual(["cA"]);
  });

  it("⭐ marcada AGORA e resolvida há 25 h continua entrando (o caminho que já funcionava)", async () => {
    const { admin, estado } = criarBancoFalso(
      [conversa("cC", { usable_for_rag_marked_at: horasAtras(0.1), status_changed_at: horasAtras(25) })],
      mensagensDe("cC"),
    );
    deps.banco.atual = admin;

    const r = await rodarLote();

    expect(r.processed).toBe(1);
    expect(estado.chunks.map((c) => (c.metadata as Linha).conversation_id)).toEqual(["cC"]);
  });

  it("marcada E resolvida há mais de 24 h fica de fora; já `ingested` e `open` também", async () => {
    const { admin, estado } = criarBancoFalso(
      [
        conversa("cFora", { usable_for_rag_marked_at: horasAtras(25), status_changed_at: horasAtras(25) }),
        conversa("cIngerida", { usable_for_rag_marked_at: horasAtras(2), status_changed_at: horasAtras(2), rag_review_status: "ingested" }),
        conversa("cAberta", { usable_for_rag_marked_at: horasAtras(2), status_changed_at: horasAtras(2), status: "open" }),
        conversa("cD", { usable_for_rag_marked_at: horasAtras(2), status_changed_at: horasAtras(2) }),
      ],
      [...mensagensDe("cFora"), ...mensagensDe("cIngerida"), ...mensagensDe("cAberta"), ...mensagensDe("cD")],
    );
    deps.banco.atual = admin;

    const r = await rodarLote();

    expect(r.processed).toBe(1);
    const ingeridas = estado.chunks.map((c) => (c.metadata as Linha).conversation_id);
    expect(ingeridas).toEqual(["cD"]);
    expect(estado.conversas.find((c) => c.id === "cFora")!.rag_review_status).toBeNull();
    expect(estado.conversas.find((c) => c.id === "cAberta")!.rag_review_status).toBeNull();
  });
});
