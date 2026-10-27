/**
 * O JEV POR OPENROUTER (issue #2947) — o que este arquivo prende.
 *
 * O Jev é um modelo da TypeSafe AI, e a OpenRouter também o serve. Os dois
 * caminhos NÃO são o mesmo pedido com outro endereço: a base, o NOME do modelo e
 * a credencial mudam, e duas dessas três mudanças são invisíveis até falharem em
 * produção:
 *
 *  1. O NOME. O autor da issue mediu, em 15/10/2026: a OpenRouter responde
 *     `400 Model typesafe/jev-1.13.0 does not exist` para o nome da TypeSafe, e
 *     200 com `provider: TypeSafe` para `typesafe/jev-1.13`. Mandar o nome da
 *     TypeSafe para lá é um 400 que o cliente traduz em `contrato_invalido` —
 *     quem opera lê "a pergunta é nossa e está errada" para uma chamada certa.
 *  2. A PROVA. Na TypeSafe o catálogo `/v1/models` EXIGE chave (401 sem ela). Na
 *     OpenRouter esse catálogo é PÚBLICO: 200 para qualquer string. Validar por
 *     ele gravaria qualquer coisa como "chave validada" — a mesma família de
 *     defeito que `provider-validators.test.ts` já prende para o provedor
 *     OpenRouter. Quem prova a chave lá é `/v1/key`.
 *
 * Nenhum caso aqui toca a rede: o `fetch` é sempre injetado, e o banco e a
 * decifragem são dublês (o mesmo formato de `ponto.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// A base vem de `env`; este mock decide se a variável existe, para o `.env` de
// quem roda o teste não mandar no resultado.
const envMock = vi.hoisted(() => ({ JEV_API_BASE_URL: "" as string | undefined, OPENROUTER_BASE_URL: "" as string | undefined }));
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));

// ── Dublês do banco e da decifragem, para `destinoDasTarefas` real ───────────
const banco = vi.hoisted(() => ({
  settings: null as Record<string, unknown> | null,
  linha: null as Record<string, unknown> | null,
  erro: null as { name: string; message: string } | null,
  chamadas: [] as Array<[string, ...unknown[]]>,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      banco.chamadas.push(["from", tabela]);
      const chain: Record<string, unknown> = {};
      for (const metodo of ["select", "eq", "not", "order", "limit"]) {
        chain[metodo] = (...args: unknown[]) => {
          banco.chamadas.push([metodo, ...args]);
          return chain;
        };
      }
      chain.maybeSingle = async () =>
        tabela === "organizations"
          ? { data: banco.settings === null ? null : { settings: banco.settings }, error: null }
          : { data: banco.linha, error: banco.erro };
      return chain;
    },
  }),
}));

vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: (v: unknown) => v,
  decryptKey: (c: { ciphertext: unknown }) => `decifrada:${String(c.ciphertext)}`,
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined },
}));

import { decidir } from "@/lib/ai/decisao/cliente";
import { MODELO_DA_TYPESAFE, MODELO_NA_OPENROUTER, modeloDaOrigem, ORIGEM_PADRAO, provedorDaCredencial } from "@/lib/ai/decisao/origem";
import { decidirNoPonto, destinoDasTarefas } from "@/lib/ai/decisao/ponto";
import { TAREFA_DO_CLIMA } from "@/lib/ai/decisao/tarefas";
import { validateTypeSafeKey } from "@/lib/ai/provider-validators";

const ORG = "11111111-1111-4111-8111-111111111111";
const CREDENCIAL = {
  api_key_encrypted: "cifra",
  api_key_iv: "iv",
  api_key_tag: "tag",
};
const PONTO_DO_CLIMA = "sentiment_classify";

/** Ligado COM aceite — o único estado em que a chave pode sair. */
const LIGADO = {
  jev: {
    ligado: true,
    modo: "observacao",
    aceite: { em: "2026-09-23T12:00:00.000Z", por: "22222222-2222-4222-8222-222222222222" },
  },
};

const PERGUNTAS = {
  clima: { tipo: "score", instrucao: "Qual o clima?", criterios: ["péssimo", "neutro", "ótimo"] },
} as const;

const CORPO_OK = {
  model: MODELO_DA_TYPESAFE,
  answers: {
    clima: {
      type: "score",
      score: 1.4,
      legend: { "0": "péssimo", "1": "neutro", "2": "ótimo" },
      probabilities: { "0": 0.1, "1": 0.4, "2": 0.5 },
      confidence: 0.82,
    },
  },
  usage: { input_tokens: 412, output_tokens: 0 },
};

/** Uma resposta HTTP de verdade; o `fetch` injetado é quem a entrega. */
function respostaHttp(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Pedido {
  url: string;
  corpo: { model?: string };
}

/** Captura o pedido e responde — sem rede nenhuma. */
function fetchQueCaptura(pedidos: Pedido[], resposta: Response = respostaHttp(200, CORPO_OK)) {
  return vi.fn(async (input: string | URL | RequestInfo, init?: RequestInit) => {
    pedidos.push({ url: String(input), corpo: JSON.parse(String(init?.body ?? "{}")) as { model?: string } });
    return resposta;
  });
}

beforeEach(() => {
  envMock.JEV_API_BASE_URL = "";
  envMock.OPENROUTER_BASE_URL = "";
  banco.settings = LIGADO;
  banco.linha = null;
  banco.erro = null;
  banco.chamadas.length = 0;
});

describe("o vocabulário das duas origens", () => {
  it("cada origem tem o seu nome de modelo, e o da OpenRouter é o prefixado", () => {
    expect(modeloDaOrigem("typesafe")).toBe(MODELO_DA_TYPESAFE);
    expect(modeloDaOrigem("openrouter")).toBe(MODELO_NA_OPENROUTER);
    // O nome da TypeSafe NÃO pode vazar para a OpenRouter: é o 400 medido.
    expect(MODELO_NA_OPENROUTER).not.toBe(MODELO_DA_TYPESAFE);
    expect(MODELO_NA_OPENROUTER.startsWith("typesafe/")).toBe(true);
  });

  it("cada origem consome a credencial do seu provedor — o OpenRouter reaproveita a da conversa", () => {
    expect(provedorDaCredencial("typesafe")).toBe("typesafe");
    expect(provedorDaCredencial("openrouter")).toBe("openrouter");
    // O default não muda o caminho de sempre.
    expect(ORIGEM_PADRAO).toBe("typesafe");
  });
});

describe("decidir — a URL e o nome do modelo saem da ORIGEM", () => {
  it("origem TypeSafe (default): a base da TypeSafe e o nome fixado", async () => {
    const pedidos: Pedido[] = [];
    const r = await decidir(
      { chave: "tsk_x", estado: "cliente: adorei!", perguntas: PERGUNTAS },
      { fetchImpl: fetchQueCaptura(pedidos) },
    );
    expect(r.ok).toBe(true);
    expect(pedidos[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(pedidos[0]!.corpo.model).toBe("jev-1.13.0");
  });

  it("origem OpenRouter: a base da OpenRouter e o nome PREFIXADO (é o 400 que não pode voltar)", async () => {
    const pedidos: Pedido[] = [];
    const r = await decidir(
      { chave: "sk-or-x", estado: "cliente: adorei!", perguntas: PERGUNTAS, origem: "openrouter" },
      { fetchImpl: fetchQueCaptura(pedidos) },
    );
    expect(r.ok).toBe(true);
    expect(pedidos[0]!.url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(pedidos[0]!.corpo.model).toBe("typesafe/jev-1.13");
    // O defeito medido: o nome da TypeSafe responde 400 lá.
    expect(pedidos[0]!.corpo.model).not.toBe("jev-1.13.0");
  });
});

describe("a chave da conversa vai para onde a conversa vai", () => {
  it("com OPENROUTER_BASE_URL apontando para um gateway próprio, o Jev via OpenRouter usa ESSE host", async () => {
    envMock.OPENROUTER_BASE_URL = "https://gateway.interno.exemplo/v1";
    try {
      const pedidos: Pedido[] = [];
      await decidir(
        { chave: "sk-gw-x", estado: "cliente: adorei!", perguntas: PERGUNTAS, origem: "openrouter" },
        { fetchImpl: fetchQueCaptura(pedidos) },
      );
      expect(pedidos[0]!.url).toBe("https://gateway.interno.exemplo/v1/systemone");
      // A TypeSafe direto não é afetada pelo gateway da conversa.
      const daTypesafe: Pedido[] = [];
      await decidir(
        { chave: "tsk_x", estado: "cliente: adorei!", perguntas: PERGUNTAS },
        { fetchImpl: fetchQueCaptura(daTypesafe) },
      );
      expect(daTypesafe[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    } finally {
      envMock.OPENROUTER_BASE_URL = "";
    }
  });
});

describe("destinoDasTarefas — a credencial lida é a da ORIGEM escolhida", () => {
  it("origem OpenRouter: lê a credencial `openrouter` (a mesma da conversa) e devolve a origem junto", async () => {
    banco.settings = { jev: { ...LIGADO.jev, origem: "openrouter" } };
    banco.linha = CREDENCIAL;
    const destino = await destinoDasTarefas(ORG, []);
    // Sem tarefa do Jev não se lê nada — o controle do caminho curto.
    expect(destino).toBeNull();

    const destinoDoClima = await destinoDasTarefas(ORG, [TAREFA_DO_CLIMA]);
    expect(destinoDoClima).not.toBeNull();
    expect(destinoDoClima!.chave).toBe("decifrada:cifra");
    expect(destinoDoClima!.origem).toBe("openrouter");
    expect(banco.chamadas).toContainEqual(["eq", "provider", "openrouter"]);
    expect(banco.chamadas).not.toContainEqual(["eq", "provider", "typesafe"]);
  });

  it("origem TypeSafe (default): continua lendo a credencial `typesafe`, como sempre", async () => {
    banco.linha = CREDENCIAL;
    const destino = await destinoDasTarefas(ORG, [TAREFA_DO_CLIMA]);
    expect(destino!.origem).toBe("typesafe");
    expect(banco.chamadas).toContainEqual(["eq", "provider", "typesafe"]);
    expect(banco.chamadas).not.toContainEqual(["eq", "provider", "openrouter"]);
  });

  it("ponta a ponta no unit: a origem lida leva a chamada para a OpenRouter, com o nome prefixado", async () => {
    banco.settings = { jev: { ...LIGADO.jev, origem: "openrouter" } };
    banco.linha = CREDENCIAL;
    const pedidos: Pedido[] = [];
    const r = await decidirNoPonto(
      { ponto: PONTO_DO_CLIMA, organizationId: ORG, estado: "cliente: adorei!", perguntas: PERGUNTAS },
      { fetchImpl: fetchQueCaptura(pedidos) },
    );
    expect(r.ok).toBe(true);
    expect(pedidos[0]!.url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(pedidos[0]!.corpo.model).toBe("typesafe/jev-1.13");
  });
});

describe("validateTypeSafeKey — a chave é provada no caminho CERTO de cada origem", () => {
  const chamadas: string[] = [];

  function fetchPorUrl(respostas: Record<string, number>) {
    return vi.fn(async (url: string) => {
      chamadas.push(url);
      const chave = Object.keys(respostas).find((k) => url.endsWith(k));
      return {
        ok: (respostas[chave ?? ""] ?? 404) < 400,
        status: respostas[chave ?? ""] ?? 404,
        json: async () => ({ models: [{ name: MODELO_DA_TYPESAFE }] }),
      } as unknown as Response;
    });
  }

  beforeEach(() => {
    chamadas.length = 0;
  });

  it("origem TypeSafe: prova em /v1/models, sobre a base da TypeSafe", async () => {
    const fetchImpl = fetchPorUrl({ "/v1/models": 200 });
    vi.stubGlobal("fetch", fetchImpl);
    const r = await validateTypeSafeKey("tsk_x");
    expect(r.ok).toBe(true);
    expect(chamadas).toEqual(["https://api.typesafe.ai/v1/models"]);
    vi.unstubAllGlobals();
  });

  it("origem OpenRouter: prova em /v1/key — o catálogo de lá é público e não prova nada", async () => {
    const fetchImpl = fetchPorUrl({ "/v1/key": 200 });
    vi.stubGlobal("fetch", fetchImpl);
    const r = await validateTypeSafeKey("sk-or-x", "openrouter");
    expect(r.ok).toBe(true);
    expect(chamadas).toEqual(["https://openrouter.ai/api/v1/key"]);
    vi.unstubAllGlobals();
  });

  it("o caso decisivo: catálogo público 200 + chave recusada — a recusa vence", async () => {
    // Era EXATAMENTE este o defeito: o catálogo da OpenRouter responde 200 para
    // qualquer string, e validar por ele gravaria uma chave falsa como validada.
    const fetchImpl = fetchPorUrl({ "/v1/key": 401, "/v1/models": 200 });
    vi.stubGlobal("fetch", fetchImpl);
    const r = await validateTypeSafeKey("chave_de_qualquer_um", "openrouter");
    expect(r).toEqual({ ok: false, error: "auth_failed_401" });
    expect(chamadas).not.toContain("https://openrouter.ai/api/v1/models");
    vi.unstubAllGlobals();
  });

  it("as duas origens recusam a chave inválida com o MESMO código, e nenhuma delas responde ok", async () => {
    vi.stubGlobal("fetch", fetchPorUrl({ "/v1/models": 401, "/v1/key": 401 }));
    expect(await validateTypeSafeKey("ruim")).toEqual({ ok: false, error: "auth_failed_401" });
    expect(await validateTypeSafeKey("ruim", "openrouter")).toEqual({ ok: false, error: "auth_failed_401" });
    vi.unstubAllGlobals();
  });
});
