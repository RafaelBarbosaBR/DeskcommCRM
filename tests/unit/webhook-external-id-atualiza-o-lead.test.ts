import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2316 — o segundo evento da mesma pessoa NÃO é reenvio: é o card sendo
 * ATUALIZADO.
 *
 * A ferramenta de fora manda cadastro → Pix gerado → pagou → cadastrou o
 * primeiro talhão para a MESMA pessoa, sempre com o mesmo `external_id`. Hoje
 * os eventos 2/3/4 caem no `outcome: "duplicado"` (linhas 343 e 609 do webhook
 * de entrada): o valor pago, a área e a etapa nunca chegavam ao card.
 *
 * A régua é UMA, e ela é o DADO, não o id: o envio trouxe campo DIFERENTE do
 * que o card tem → atualiza (`atualizado`); repetiu o que já estava gravado →
 * idempotência de sempre (200 com o lead existente, nada muda, `duplicado`).
 * Os dois caminhos — o fast-path de dedup e a corrida do retry, em que o
 * índice único derruba o segundo INSERT — passam por essa mesma régua.
 */

const h = vi.hoisted(() => ({
  registrar: vi.fn(async () => undefined),
  criarLead: vi.fn(),
  atualizarLead: vi.fn(async (..._args: unknown[]) => ({ id: "lead-1" })),
  moverLead: vi.fn(async (..._args: unknown[]) => ({ id: "lead-1" })),
  /** Respostas por tabela. Cada LEITURA desloca a primeira; a última repete. */
  leituras: new Map<string, Array<Record<string, unknown>>>(),
}));

/**
 * Cadeia do PostgREST que só sabe resolver na hora do `await` — o caminho que
 * a rota percorre (select/eq/eq/maybeSingle, insert, order) devolve sempre a
 * MESMA cadeia, e a resposta vem da fila `h.leituras`.
 */
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

const FONTE = {
  id: "fonte-1",
  name: "Integração do diagnóstico",
  organization_id: "org-1",
  secret_encrypted: null,
  default_pipeline_id: "pipe-1",
  default_stage_id: "stage-1",
  field_map: {},
  form_fields: [],
  redirect_to: null,
  is_active: true,
  authorize_ai_on_capture: false,
  /**
   * A OPÇÃO LIGADA (#2316, migration 0683): estes casos medem o comportamento
   * das ferramentas que integram de verdade, com a fonte configurada para
   * atualizar. Que o PADRÃO seja desligado — e que o card de outra fonte fique
   * de fora — é o que a `webhook-atualizacao-de-card-e-opcao-por-fonte` cobre.
   */
  update_existing_lead_on_capture: true,
};

/** O card que a pessoa JÁ tem — o primeiro evento (cadastro) que entrou. */
const CARD = {
  id: "lead-1",
  contact_id: "contato-1",
  // A fonte que criou o card: a régua só atualiza o card DESTA fonte.
  webhook_source_id: "fonte-1",
  title: "Joana",
  custom_fields: { valor_pago: "100", area_ha: "2" },
  pipeline_id: "pipe-1",
  stage_id: "stage-1",
};

const ETAPAS = [
  { id: "stage-1", name: "Cadastro", position: 1 },
  { id: "stage-2", name: "Pagou", position: 2 },
  { id: "stage-3", name: "Primeiro talhão", position: 3 },
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

import { ApiError } from "@/lib/api/types";
import { POST } from "@/app/api/v1/webhooks/in/[token]/route";

const TOKEN = "token-da-fonte-0001";

async function enviar(corpo: Record<string, unknown>): Promise<Response | Error> {
  const req = new NextRequest(`http://localhost/api/v1/webhooks/in/${TOKEN}`, {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
  return POST(req, { params: Promise.resolve({ token: TOKEN }) }).catch((e: Error) => e);
}

/** O patch que foi de fato mandado ao `updateLeadHandler`, se houver. */
function patchEnviado(): Record<string, unknown> | undefined {
  return h.atualizarLead.mock.calls[0]?.[3] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  h.registrar.mockClear();
  h.criarLead.mockReset();
  h.atualizarLead.mockClear();
  h.moverLead.mockClear();
  h.leituras.clear();
  h.leituras.set("webhook_sources", [{ data: FONTE, error: null }]);
  h.leituras.set("crm_stages", [{ data: ETAPAS, error: null }]);
});

describe("external_id que já existe com dado DIFERENTE (#2316)", () => {
  beforeEach(() => {
    h.leituras.set("crm_leads", [{ data: CARD, error: null }]);
  });

  it("⭐ o card é atualizado com o campo novo, e o desfecho é atualizado", async () => {
    // O evento "pagou": o mesmo external_id, agora com o valor REAL. `area_ha`
    // vem igual ao que já está gravado — reenviar o mesmo valor não é dado novo.
    const res = await enviar({
      external_id: "ext-1",
      nome: "Joana",
      telefone: "+5511999990000",
      valor_pago: "250",
      area_ha: "2",
    });

    expect(h.criarLead, "card novo para alguém que já tem card").not.toHaveBeenCalled();
    expect(patchEnviado()).toEqual({ custom_fields: { valor_pago: "250" } });
    expect(h.registrar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "atualizado", leadId: "lead-1", contactId: "contato-1" }),
    );
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(200);
    expect(await (res as Response).json()).toEqual({ data: { lead_id: "lead-1" } });
  });

  it("external_id e stage NUNCA viram campo personalizado no card", async () => {
    await enviar({
      external_id: "ext-1",
      stage: "Primeiro talhão",
      nome: "Joana",
      telefone: "+5511999990000",
      valor_pago: "250",
    });

    const campos = (patchEnviado()?.custom_fields ?? {}) as Record<string, unknown>;
    expect(Object.keys(campos)).not.toContain("external_id");
    expect(Object.keys(campos)).not.toContain("stage");
  });

  it("o envio pede etapa MAIS À FRENTE: o card anda e o desfecho é atualizado", async () => {
    const res = await enviar({
      external_id: "ext-1",
      nome: "Joana",
      telefone: "+5511999990000",
      stage: "Primeiro talhão",
    });

    expect(h.moverLead).toHaveBeenCalledWith(expect.anything(), expect.anything(), "lead-1", {
      to_stage_id: "stage-3",
    });
    expect(h.registrar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "atualizado", leadId: "lead-1", contactId: "contato-1" }),
    );
    expect((res as Response).status).toBe(200);
  });

  it("etapa pedida para TRÁS não puxa o card: o envio vira reenvio comum", async () => {
    h.leituras.set("crm_leads", [{ data: { ...CARD, stage_id: "stage-3" }, error: null }]);

    const res = await enviar({
      external_id: "ext-1",
      nome: "Joana",
      telefone: "+5511999990000",
      stage: "Cadastro",
    });

    expect(h.moverLead, "webhook não anda para trás").not.toHaveBeenCalled();
    expect(h.atualizarLead).not.toHaveBeenCalled();
    expect(h.registrar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "duplicado", leadId: "lead-1" }),
    );
    expect((res as Response).status).toBe(200);
  });

  it("etapa pedida que não existe no funil: o resto do envio atualiza, sem mover", async () => {
    const res = await enviar({
      external_id: "ext-1",
      nome: "Joana",
      telefone: "+5511999990000",
      valor_pago: "250",
      stage: "Etapa que ninguém cadastrou",
    });

    expect(h.moverLead).not.toHaveBeenCalled();
    expect(patchEnviado()).toEqual({ custom_fields: { valor_pago: "250" } });
    expect(h.registrar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "atualizado" }),
    );
    expect((res as Response).status).toBe(200);
  });

  it("o card não pôde ser atualizado (handler recusou): o envio NÃO vira loop de retry", async () => {
    h.atualizarLead.mockRejectedValueOnce(
      new ApiError(422, "required_fields_missing", undefined, "req-1"),
    );

    const res = await enviar({
      external_id: "ext-1",
      nome: "Joana",
      telefone: "+5511999990000",
      valor_pago: "250",
    });

    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(200);
    expect(await (res as Response).json()).toEqual({ data: { lead_id: "lead-1" } });
    expect(h.registrar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "atualizado", leadId: "lead-1" }),
    );
  });
});

describe("external_id que já existe com payload IDÊNTICO (#2316)", () => {
  beforeEach(() => {
    h.leituras.set("crm_leads", [{ data: CARD, error: null }]);
  });

  it("⭐ nada muda: sem escrita, 200 com o lead existente e desfecho duplicado", async () => {
    const res = await enviar({
      external_id: "ext-1",
      nome: "Joana",
      telefone: "+5511999990000",
      valor_pago: "100",
      area_ha: "2",
    });

    expect(h.atualizarLead, "reenvio idêntico escreveu no card").not.toHaveBeenCalled();
    expect(h.moverLead).not.toHaveBeenCalled();
    expect(h.criarLead).not.toHaveBeenCalled();
    expect(h.registrar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "duplicado", leadId: "lead-1", contactId: "contato-1" }),
    );
    expect((res as Response).status).toBe(200);
    expect(await (res as Response).json()).toEqual({ data: { lead_id: "lead-1" } });
  });

  it("mesmo valor com outro tipo (100 gravado, '100' reenviado) é o MESMO dado", async () => {
    h.leituras.set("crm_leads", [
      { data: { ...CARD, custom_fields: { valor_pago: 100 } }, error: null },
    ]);

    await enviar({
      external_id: "ext-1",
      nome: "Joana",
      telefone: "+5511999990000",
      valor_pago: "100",
    });

    expect(h.atualizarLead).not.toHaveBeenCalled();
    expect(h.registrar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "duplicado" }),
    );
  });
});

describe("corrida do retry: o índice único derruba o segundo INSERT (#2316)", () => {
  it("⭐ o vencedor passa pela MESMA régua: dado novo atualiza, desfecho atualizado", async () => {
    h.leituras.set("crm_leads", [
      // fast-path: ninguém ainda — os dois POSTs simultâneos passam por aqui.
      { data: null, error: null },
      // o vencedor da corrida, com o dado do OUTRO envio.
      { data: { ...CARD, custom_fields: { valor_pago: "100" } }, error: null },
    ]);
    h.criarLead.mockRejectedValue(
      new ApiError(
        409,
        "unique_violation",
        undefined,
        "req-1",
        'duplicate key value violates constraint "uniq_crm_leads_org_source_external"',
      ),
    );

    const res = await enviar({
      external_id: "ext-1",
      nome: "Joana",
      telefone: "+5511999990000",
      valor_pago: "300",
    });

    expect(patchEnviado()).toEqual({ custom_fields: { valor_pago: "300" } });
    expect(h.registrar).toHaveBeenCalledWith(
      expect.anything(),
      // O vínculo do CONTATO DESTE ENVIO (resolvido acima) é o que o gatilho de
      // anonimização alcança; o do vencedor é o plano B.
      expect.objectContaining({ outcome: "atualizado", leadId: "lead-1" }),
    );
    expect((res as Response).status).toBe(200);
    expect(await (res as Response).json()).toEqual({ data: { lead_id: "lead-1" } });
  });

  it("corrida com payload IDÊNTICO continua idempotente", async () => {
    h.leituras.set("crm_leads", [
      { data: CARD, error: null },
      { data: CARD, error: null },
    ]);
    h.criarLead.mockRejectedValue(
      new ApiError(
        409,
        "unique_violation",
        undefined,
        "req-1",
        'duplicate key value violates constraint "uniq_crm_leads_org_source_external"',
      ),
    );

    const res = await enviar({
      external_id: "ext-1",
      nome: "Joana",
      telefone: "+5511999990000",
      valor_pago: "100",
      area_ha: "2",
    });

    expect(h.atualizarLead).not.toHaveBeenCalled();
    expect(h.registrar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "duplicado", leadId: "lead-1" }),
    );
    expect((res as Response).status).toBe(200);
  });
});
