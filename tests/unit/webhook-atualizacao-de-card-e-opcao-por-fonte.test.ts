import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A ATUALIZAÇÃO DO CARD É UMA OPÇÃO DA FONTE, E NASCE DESLIGADA (#2316).
 *
 * O #2316 fez o webhook de entrada ATUALIZAR o card quando chega um
 * `external_id` repetido com dado novo — o valor pago, a área, a etapa pedida.
 * Como estava, a régua valia para TODA fonte de TODA instalação, e a issue
 * pedia uma OPÇÃO POR FONTE, desligada por padrão. O mantenedor mediu o efeito
 * que ninguém pediu: o vendedor corrige o título ou um campo do card à mão e o
 * próximo retry da ferramenta (ou um evento antigo) reescreve por cima, porque
 * a comparação é com o valor ATUAL e o envio conta como "dado novo".
 *
 * Dois portões, e os dois são o que este arquivo fixa:
 *
 *   1. `webhook_sources.update_existing_lead_on_capture` DESLIGADA (o padrão da
 *      coluna, migration 0683) → o envio repetido é reenvio e nada no card
 *      muda, exatamente como antes do #2316. A edição manual sobrevive.
 *   2. Ligada, ela só alcança o card que ESTA fonte criou
 *      (`crm_leads.webhook_source_id`) — sem isso a fonte A reescreveria o card
 *      que nasceu na fonte B, já que a busca é por organização + `external_id`.
 */

const h = vi.hoisted(() => ({
  registrar: vi.fn(async () => undefined),
  criarLead: vi.fn(async () => ({ id: "lead-1" })),
  atualizarLead: vi.fn(async (..._args: unknown[]) => ({ id: "lead-1" })),
  moverLead: vi.fn(async (..._args: unknown[]) => ({ id: "lead-1" })),
  /** Respostas por tabela. Cada LEITURA desloca a primeira; a última repete. */
  leituras: new Map<string, Array<Record<string, unknown>>>(),
}));

/** Cadeia do PostgREST que só resolve na hora do `await`, como na rota real. */
function cadeia(tabela: string): unknown {
  const proxima = (): Record<string, unknown> => {
    const fila = h.leituras.get(tabela) ?? [];
    if (fila.length === 0) return { data: null, error: null };
    if (fila.length > 1) return fila.shift() as Record<string, unknown>;
    return fila[0] as Record<string, unknown>;
  };
  const proxy: unknown = new Proxy(() => undefined, {
    get(_alvo, prop) {
      if (prop === "then") return (ok: (v: unknown) => unknown) => ok(proxima());
      return () => proxy;
    },
  });
  return proxy;
}

/** A fonte COM a opção ligada — o estado de quem integra de verdade. */
const FONTE_LIGADA = {
  id: "fonte-1",
  name: "Integração do diagnóstico",
  organization_id: "org-1",
  // Sem segredo: a fonte entra pela rota pública. Quem cobra "a opção exige
  // assinatura" é a BORDA (o PATCH da fonte), não a rota de captação — o caso
  // dela é o do formulário HTML, que não tem como assinar.
  secret_encrypted: null,
  default_pipeline_id: "pipe-1",
  default_stage_id: "stage-1",
  field_map: {},
  form_fields: [],
  redirect_to: null,
  is_active: true,
  authorize_ai_on_capture: false,
  update_existing_lead_on_capture: true,
};

/**
 * A fonte que NUNCA ligou a opção. `update_existing_lead_on_capture` ausente é
 * de propósito em um dos casos: é assim que a coluna chega numa instalação cujo
 * `update.sh` ainda não rodou — e o que não está ligado é desligado.
 */
const FONTE_DESLIGADA = { ...FONTE_LIGADA, update_existing_lead_on_capture: false };

/** O card que a pessoa já tem, criado pela fonte 1, com edição MANUAL em cima. */
const CARD_DA_FONTE_1 = {
  id: "lead-1",
  contact_id: "contato-1",
  webhook_source_id: "fonte-1",
  // "J" foi corrigido à mão depois do primeiro evento: a integração ainda tem
  // "Joana" do lado dela, e é esse reenvio que não pode desfazer a correção.
  title: "Joana",
  custom_fields: { valor_pago: "100", area_ha: "2" },
  pipeline_id: "pipe-1",
  stage_id: "stage-1",
};

const ETAPAS = [
  { id: "stage-1", name: "Cadastro", position: 1 },
  { id: "stage-2", name: "Pagou", position: 2 },
];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: cadeia, rpc: async () => ({ data: {}, error: null }) }),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/webhooks/captacao", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  registrarCaptacao: h.registrar,
}));
vi.mock("@/app/api/v1/leads/_handler", () => ({
  createLeadHandler: h.criarLead,
  updateLeadHandler: h.atualizarLead,
  moveLeadHandler: h.moverLead,
}));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({ kickLocalPipeline: async () => undefined }));

import { POST } from "@/app/api/v1/webhooks/in/[token]/route";

const TOKEN = "token-da-fonte-0001";

async function enviar(corpo: Record<string, unknown>): Promise<Response> {
  const req = new NextRequest(`http://localhost/api/v1/webhooks/in/${TOKEN}`, {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
  return (await POST(req, { params: Promise.resolve({ token: TOKEN }) })) as Response;
}

/** O envio "pagou" da integração: mesmo external_id, valor novo. */
const ENVIO_COM_DADO_NOVO = {
  external_id: "ext-1",
  nome: "Joana",
  telefone: "+5511999990000",
  valor_pago: "250",
};

/** O que o reenvio decidiu, na linha de captação. */
function desfecho(): string | undefined {
  const chamadas = h.registrar.mock.calls as unknown as Array<
    [unknown, { outcome?: string }]
  >;
  return chamadas.at(-1)?.[1]?.outcome;
}

beforeEach(() => {
  h.registrar.mockClear();
  h.criarLead.mockClear();
  h.atualizarLead.mockClear();
  h.moverLead.mockClear();
  h.leituras.clear();
  h.leituras.set("crm_stages", [{ data: ETAPAS, error: null }]);
});

describe("a opção da fonte decide se o reenvio escreve no card (#2316)", () => {
  it("⭐ opção DESLIGADA: o envio com dado novo NÃO toca no card", async () => {
    h.leituras.set("webhook_sources", [{ data: FONTE_DESLIGADA, error: null }]);
    h.leituras.set("crm_leads", [{ data: CARD_DA_FONTE_1, error: null }]);

    const res = await enviar(ENVIO_COM_DADO_NOVO);

    expect(
      h.atualizarLead,
      "a opção desligada deixou a integração reescrever o card — é a edição manual do vendedor indo embora",
    ).not.toHaveBeenCalled();
    expect(h.moverLead).not.toHaveBeenCalled();
    expect(desfecho()).toBe("duplicado");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { lead_id: "lead-1" } });
  });

  it("coluna AUSENTE (instalação sem a migration aplicada) é desligada, não ligada", async () => {
    const semColuna = { ...FONTE_LIGADA } as Record<string, unknown>;
    delete semColuna.update_existing_lead_on_capture;
    h.leituras.set("webhook_sources", [{ data: semColuna, error: null }]);
    h.leituras.set("crm_leads", [{ data: CARD_DA_FONTE_1, error: null }]);

    await enviar(ENVIO_COM_DADO_NOVO);

    expect(h.atualizarLead).not.toHaveBeenCalled();
    expect(desfecho()).toBe("duplicado");
  });

  it("⭐ opção LIGADA, mas o card nasceu em OUTRA fonte: não escreve", async () => {
    h.leituras.set("webhook_sources", [{ data: FONTE_LIGADA, error: null }]);
    h.leituras.set("crm_leads", [
      { data: { ...CARD_DA_FONTE_1, webhook_source_id: "fonte-2" }, error: null },
    ]);

    const res = await enviar(ENVIO_COM_DADO_NOVO);

    expect(
      h.atualizarLead,
      "a fonte A reescreveu o card que nasceu na fonte B",
    ).not.toHaveBeenCalled();
    expect(desfecho()).toBe("duplicado");
    expect(res.status).toBe(200);
  });

  it("⭐ card SEM fonte carimbada (anterior à coluna): na dúvida, não escreve", async () => {
    h.leituras.set("webhook_sources", [{ data: FONTE_LIGADA, error: null }]);
    h.leituras.set("crm_leads", [
      { data: { ...CARD_DA_FONTE_1, webhook_source_id: null }, error: null },
    ]);

    await enviar(ENVIO_COM_DADO_NOVO);

    expect(h.atualizarLead).not.toHaveBeenCalled();
    expect(desfecho()).toBe("duplicado");
  });

  it("⭐ a etapa pedida também respeita o portão: com a opção desligada o card não anda", async () => {
    h.leituras.set("webhook_sources", [{ data: FONTE_DESLIGADA, error: null }]);
    h.leituras.set("crm_leads", [{ data: CARD_DA_FONTE_1, error: null }]);

    await enviar({ ...ENVIO_COM_DADO_NOVO, stage: "Pagou" });

    expect(h.moverLead, "o reenvio moveu o card com a opção desligada").not.toHaveBeenCalled();
    expect(desfecho()).toBe("duplicado");
  });
});

describe("com a opção LIGADA, a régua do card da própria fonte continua valendo (#2316)", () => {
  it("dado novo no card DESTA fonte: atualiza e o desfecho é atualizado", async () => {
    h.leituras.set("webhook_sources", [{ data: FONTE_LIGADA, error: null }]);
    h.leituras.set("crm_leads", [{ data: CARD_DA_FONTE_1, error: null }]);

    const res = await enviar(ENVIO_COM_DADO_NOVO);

    expect(h.atualizarLead.mock.calls[0]?.[3]).toEqual({
      custom_fields: { valor_pago: "250" },
    });
    expect(desfecho()).toBe("atualizado");
    expect(res.status).toBe(200);
  });

  it("reenvio idêntico continua idempotente mesmo com a opção ligada", async () => {
    h.leituras.set("webhook_sources", [{ data: FONTE_LIGADA, error: null }]);
    h.leituras.set("crm_leads", [{ data: CARD_DA_FONTE_1, error: null }]);

    await enviar({
      external_id: "ext-1",
      nome: "Joana",
      telefone: "+5511999990000",
      valor_pago: "100",
      area_ha: "2",
    });

    expect(h.atualizarLead).not.toHaveBeenCalled();
    expect(desfecho()).toBe("duplicado");
  });

  it("o card de OUTRA fonte, com o MESMO external_id, não recebe nem a etapa", async () => {
    h.leituras.set("webhook_sources", [{ data: FONTE_LIGADA, error: null }]);
    h.leituras.set("crm_leads", [
      { data: { ...CARD_DA_FONTE_1, webhook_source_id: "fonte-2" }, error: null },
    ]);

    await enviar({ ...ENVIO_COM_DADO_NOVO, stage: "Pagou" });

    expect(h.moverLead).not.toHaveBeenCalled();
    expect(desfecho()).toBe("duplicado");
  });
});

describe("card de titular ANONIMIZADO não recebe dado de volta pelo reenvio (#2316, LGPD)", () => {
  /**
   * A anonimização (`fn_lgpd_cascade_redact_contact`) limpa título e campos do
   * card, mas mantém `external_id` e `webhook_source_id`. Com a opção ligada,
   * o reenvio da integração passaria pelos portões 1 e 2 e tudo pareceria
   * "novo": o nome e os campos do titular voltariam para o card.
   */
  const CARD_ANONIMIZADO = { ...CARD_DA_FONTE_1, title: "Cliente Anonimizado #1", custom_fields: {} };

  it("⭐ contato anonimizado, opção ligada, mesma fonte, nome e campo novos: nada volta", async () => {
    h.leituras.set("webhook_sources", [{ data: FONTE_LIGADA, error: null }]);
    h.leituras.set("crm_leads", [{ data: CARD_ANONIMIZADO, error: null }]);
    h.leituras.set("contacts", [{ data: { is_anonymized: true }, error: null }]);

    const res = await enviar({ ...ENVIO_COM_DADO_NOVO, stage: "Pagou" });

    expect(
      h.atualizarLead,
      "o reenvio devolveu o nome e os campos do titular a um card anonimizado",
    ).not.toHaveBeenCalled();
    expect(h.moverLead).not.toHaveBeenCalled();
    expect(desfecho()).toBe("duplicado");
    expect(res.status).toBe(200);
  });

  it("⭐ Respondi (o título não muda por desenho): o campo novo também é barrado", async () => {
    h.leituras.set("webhook_sources", [{ data: FONTE_LIGADA, error: null }]);
    h.leituras.set("crm_leads", [{ data: CARD_ANONIMIZADO, error: null }]);
    h.leituras.set("contacts", [{ data: { is_anonymized: true }, error: null }]);

    await enviar({
      external_id: "ext-1",
      form: { form_name: "Diagnóstico" },
      respondent: {
        answers: {
          "Qual é o seu nome?": "Joana",
          "Qual é o nome da sua empresa?": "Fazenda Boa Vista",
        },
      },
    });

    expect(
      h.atualizarLead,
      "no Respondi o título não conta como mudança, mas o campo do titular voltou ao card anonimizado",
    ).not.toHaveBeenCalled();
    expect(desfecho()).toBe("duplicado");
  });

  it("contato NÃO anonimizado segue a régua de sempre: o dado novo entra", async () => {
    h.leituras.set("webhook_sources", [{ data: FONTE_LIGADA, error: null }]);
    h.leituras.set("crm_leads", [{ data: CARD_DA_FONTE_1, error: null }]);
    h.leituras.set("contacts", [{ data: { is_anonymized: false }, error: null }]);

    await enviar(ENVIO_COM_DADO_NOVO);

    expect(h.atualizarLead).toHaveBeenCalledTimes(1);
    expect(desfecho()).toBe("atualizado");
  });
});
