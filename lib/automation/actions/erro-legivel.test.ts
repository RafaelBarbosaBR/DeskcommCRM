/**
 * O ERRO LEGÍVEL DAS AÇÕES DE AUTOMAÇÃO (#2980).
 *
 * ═══ O defeito ═══
 *
 * Toda ação traduzia a falha com `err instanceof Error ? err.message :
 * String(err)`. O erro do PostgREST NÃO é `Error` — é o objeto
 * `{ code, message, details, hint }` que o supabase-js entrega. O ramo
 * `String(err)` produzia a literal `"[object Object]"`, e era ISSO que
 * `automation_rule_runs.error` gravava: o operador lia "falhou" e nenhum
 * motivo, com a mensagem e o código o tempo todo dentro do objeto.
 *
 * ═══ O que se prova ═══
 *
 *  1. o HELPER extrai `message`/`code` do objeto (e não muda o texto de quem já
 *     lança `Error`), cobrindo também primitivo, objeto sem campos de erro,
 *     objeto vazio, objeto circular e o teto de tamanho;
 *  2. os CAMINHOS REAIS de duas ações (`send_ai_message`, `ai_decide`) param de
 *     registrar `[object Object]` quando a dependência rejeita com o objeto do
 *     PostgREST — é a diferença entre consertar o helper e consertar as ações.
 *
 * O `it` de anti-vacuidade abaixo fixa o input: sem ele, alguém "arruma" este
 * arquivo trocando o objeto por um `new Error(...)` e os caminhos ficam verdes
 * sem nunca ter exercido o defeito.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mensagemDeErro } from "@/lib/automation/actions/erro-legivel";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";

/** O objeto EXATO que o supabase-js põe em `error` — NÃO é `Error`. */
const ERRO_DO_POSTGREST = {
  code: "PGRST301",
  details: "JWT expired",
  hint: null,
  message: "JWT expired",
};

describe("mensagemDeErro — extrai o motivo do objeto que o `String()` apagava", () => {
  it("anti-vacuidade: o input DESTE arquivo é o que virava `[object Object]`", () => {
    // Se este `toContain` deixa de casar, o objeto deixou de ser o defeito e os
    // casos abaixo não provam mais nada.
    expect(String(ERRO_DO_POSTGREST)).toBe("[object Object]");
  });

  it("objeto do PostgREST: diz a mensagem e o código, nunca `[object Object]`", () => {
    const texto = mensagemDeErro(ERRO_DO_POSTGREST);
    expect(texto).not.toContain("[object Object]");
    expect(texto).toContain("JWT expired");
    expect(texto).toContain("PGRST301");
  });

  it("`Error` continua saindo como `err.message` (o conserto não mexe em quem já lança)", () => {
    expect(mensagemDeErro(new Error("pool esgotado"))).toBe("pool esgotado");
  });

  it("`Error` com `code` acrescenta o código sem apagar a mensagem", () => {
    const erro = Object.assign(new Error("falha de rede"), { code: "ETIMEDOUT" });
    expect(mensagemDeErro(erro)).toBe("falha de rede — código ETIMEDOUT");
  });

  it("primitivos caem para `String`", () => {
    expect(mensagemDeErro("texto cru")).toBe("texto cru");
    expect(mensagemDeErro(503)).toBe("503");
    expect(mensagemDeErro(null)).toBe("null");
    expect(mensagemDeErro(undefined)).toBe("undefined");
  });

  it("objeto sem campos de erro diz os NOMES dos campos, não `[object Object]`", () => {
    const texto = mensagemDeErro({ fora: true, tentativas: 3 });
    expect(texto).not.toContain("[object Object]");
    expect(texto).toContain("tentativas");
  });

  it("objeto vazio e objeto circular têm texto explícito — nunca `[object Object]`", () => {
    expect(mensagemDeErro({})).toBe("erro sem mensagem");
    const circular: Record<string, unknown> = {};
    circular.eu = circular;
    expect(mensagemDeErro(circular)).toBe("erro sem mensagem (campos: eu)");
  });

  it("objeto sem mensagem nunca grava os VALORES dos campos (cabeçalho, token)", () => {
    const texto = mensagemDeErro({ headers: { authorization: "Bearer tok_x" } });
    expect(texto).not.toContain("tok_x");
    expect(texto).toContain("headers");
  });

  it("o `code` numérico legado do DOMException não vira 'código 23'", () => {
    const erro = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(mensagemDeErro(erro)).toBe("The operation was aborted due to timeout");
  });

  it("sem `limite`, a mensagem sai inteira (a instrução do erro de configuração da IA)", () => {
    const instrucao =
      "o endereço de IA configurado para esta empresa só é usado com a chave dela, e ela não tem chave cadastrada para este provedor — a chave da instalação não é enviada a endereço escolhido pela empresa; cadastre a chave da empresa em Agente de IA › Provedores, ou tire o endereço próprio para voltar ao provedor padrão da instalação";
    expect(instrucao.length).toBeGreaterThan(200);
    const texto = mensagemDeErro(new Error(instrucao));
    expect(texto).toBe(instrucao);
    expect(texto).toContain("Agente de IA › Provedores");
  });

  it("o `limite` trunca sem reintroduzir o defeito", () => {
    const texto = mensagemDeErro(ERRO_DO_POSTGREST, 4);
    expect(texto).toBe("JWT ");
    expect(texto).not.toContain("[object Object]");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Caminhos REAIS das ações.
// ─────────────────────────────────────────────────────────────────────────────

const serviceForAutomation = vi.fn();
const decidirPreGoLiveDoCanalViaSupabase = vi.fn();
const dadosDoFormularioDoContexto = vi.fn();
const decidirAcao = vi.fn();

vi.mock("@/lib/automation/guarda-do-contato", () => ({
  checarGuardasDeContato: () => ({
    ok: true,
    contact: { id: "contato-1", name: "Fulano", phone_number: "+5511999998888" },
  }),
}));
vi.mock("@/lib/ai/elegibilidade/consulta-pre-go-live", () => ({
  decidirPreGoLiveDoCanalViaSupabase: (...args: unknown[]) =>
    decidirPreGoLiveDoCanalViaSupabase(...args),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
// Os módulos abaixo entram no grafo de `send-ai-message.ts`: mocká-los é o que
// torna a AÇÃO importável fora do runtime do Next/env (mesmo conjunto de
// `send-ai-message.test.ts`). Nenhum caminho destes testes os executa.
vi.mock("@/lib/automation/throttle", () => ({
  espacarEnvio: vi.fn(async () => undefined),
  checkDailyLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: vi.fn() }));
vi.mock("@/lib/automation/start-conversation", () => ({ ensureConversation: vi.fn() }));
vi.mock("@/lib/agent-engine/agent/abordagem-de-formulario", () => ({
  gerarAbordagemDeFormulario: vi.fn(),
}));
vi.mock("@/lib/automation/dados-do-formulario", () => ({
  dadosDoFormularioDoContexto: (...args: unknown[]) => dadosDoFormularioDoContexto(...args),
}));
vi.mock("@/lib/atendimento/origem-automacao", () => ({
  serviceForAutomation: (...args: unknown[]) => serviceForAutomation(...args),
  originFromAutomationEvent: vi.fn(async () => null),
}));
vi.mock("@/lib/agent-engine/agent/decisao-de-acao", () => ({
  decidirAcao: (...args: unknown[]) => decidirAcao(...args),
}));
vi.mock("@/lib/automation/ai-decide-da-org", () => ({ aiDecideLigado: vi.fn(async () => true) }));

import { getAction } from "@/lib/automation/actions";

import "@/lib/automation/actions/send-ai-message";
import "@/lib/automation/actions/ai-decide";

const ORG = "11111111-1111-4111-8111-111111111111";

function ctxDeEnvio(): ActionCtx {
  return {
    admin: {} as ActionCtx["admin"],
    organizationId: ORG,
    ruleId: "regra-1",
    ruleName: "Automação de teste",
    requestId: "req-1",
    event: {} as ActionCtx["event"],
    context: { contact: { id: "contato-1", phone_number: "+5511999998888" } },
  };
}

function executar(tipo: string, ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  const acao = getAction(tipo);
  if (!acao) throw new Error(`ação ${tipo} não está registrada`);
  return acao.execute(ctx, config);
}

const CONFIG_IA = {
  channel_session_id: "22222222-2222-4222-8222-222222222222",
  agent_id: "agente-1",
  instruction: "Cumprimente e pergunte o bairro.",
};

const CONFIG_DECIDE = {
  custo_de_token: true,
  instrucao: "Decida.",
  opcoes: [
    { id: "a", rotulo: "Opção A", acao: { type: "add_tag", config: { tags: ["a"] } } },
    { id: "b", rotulo: "Opção B", acao: { type: "add_tag", config: { tags: ["b"] } } },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  decidirPreGoLiveDoCanalViaSupabase.mockResolvedValue({ permite: true });
  dadosDoFormularioDoContexto.mockResolvedValue({ dados: {}, origem: null, origemDaAbordagem: null });
});

describe("nenhum caminho de ação produz `[object Object]`", () => {
  it("send_ai_message: a guarda de pré-go-live rejeita com o objeto do PostgREST", async () => {
    decidirPreGoLiveDoCanalViaSupabase.mockRejectedValue(ERRO_DO_POSTGREST);

    const r = await executar("send_ai_message", ctxDeEnvio(), CONFIG_IA);

    const texto = JSON.stringify(r);
    expect(texto).not.toContain("[object Object]");
    expect(r).toMatchObject({
      status: "skipped",
      detail: { reason: "elegibilidade_indeterminada" },
    });
    expect((r.detail as { error?: string }).error).toContain("JWT expired");
  });

  it("send_ai_message: a resolução da fronteira rejeita com o objeto do PostgREST", async () => {
    serviceForAutomation.mockRejectedValue(ERRO_DO_POSTGREST);

    const r = await executar("send_ai_message", ctxDeEnvio(), CONFIG_IA);

    expect(JSON.stringify(r)).not.toContain("[object Object]");
    expect(r).toMatchObject({ status: "failed" });
    expect(r.error).toContain("JWT expired");
  });

  it("ai_decide: o modelo rejeita com o objeto do PostgREST", async () => {
    decidirAcao.mockRejectedValue(ERRO_DO_POSTGREST);

    const r = await executar("ai_decide", ctxDeEnvio(), CONFIG_DECIDE);

    expect(JSON.stringify(r)).not.toContain("[object Object]");
    expect(r).toMatchObject({ status: "failed" });
    expect(r.error).toContain("JWT expired");
    expect(r.error).toContain("PGRST301");
  });
});
