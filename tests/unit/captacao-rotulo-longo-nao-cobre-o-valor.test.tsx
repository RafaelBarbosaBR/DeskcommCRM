/**
 * CATRACA: o RÓTULO do detalhe da captação quebra DENTRO da própria célula.
 *
 * ## O defeito (#3014), medido no arquivo
 *
 * No painel que abre ao clicar numa linha de "Webhooks › Entrada › fonte ›
 * histórico", cada par rótulo/valor é um `grid-cols-[minmax(0,7rem)_1fr]`: a
 * primeira trilha tem TETO de 7rem (`app/app/webhooks/_components/CapturaDetail.tsx`,
 * componente `Linha`). O `<dd>` já trazia `min-w-0 break-words`; o `<dt>` não
 * tinha regra de quebra nenhuma.
 *
 * Um rótulo que é UMA palavra sem espaço — a chave crua que o formulário mandou
 * (`disposto_investir_1500_reais_por_mes_em_trafego`) ou uma chave UUID de
 * pergunta — não tem onde quebrar. Os glifos vazam da caixa de 7rem e são
 * PINTADOS por cima do valor ao lado: rótulo e valor ficam ilegíveis os dois.
 *
 * ## Por que a régua é sobre CLASSE, e o que ela vigia
 *
 * O jsdom não tem motor de layout: `getComputedStyle` devolve vazio e medir
 * largura aqui daria zero em tudo, verde por ausência de motor. O que dá para
 * prender — e é o que regride — é a REGRA de quebra do `<dt>`, textual. Mesma
 * limitação declarada de `inbox-header-nao-trava.test.tsx`.
 *
 * Duas coisas a régua exige, e a segunda é a que o #3014 cita no contrato:
 *
 *  1. O `<dt>` carrega uma quebra forçada (o par que o `<dd>` já tinha).
 *  2. A quebra é `wrap-anywhere` (ou `break-all`), NÃO `overflow-hidden` nem
 *     `truncate`: cortar o rótulo o torna ilegível — o pedido é que ele caiba
 *     quebrando, continuando legível.
 *
 * E o caso de controle: com rótulo curto a classe é EXATAMENTE a mesma. Ela é
 * estática, não condicional — o conserto não pode depender do tamanho do texto
 * nem empurrar a coluna; o rótulo curto continua numa linha só, na trilha de
 * 7rem de sempre.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { LeadCaptureRow } from "@/hooks/webhooks/useLeadCaptures";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/app/actions/settings/updatePipelineConfig", () => ({
  updatePipelineConfig: vi.fn(async () => ({ ok: true })),
}));

// Sem fonte/funil legível, `useCampoDoFunilDaCaptacao` fica `pronto: false`: a
// tela mostra a CHAVE crua como rótulo e não oferece "Cadastrar como campo do
// lead". É o caso do #3014 — a chave longa que o formulário mandou.
vi.mock("@/hooks/webhooks/useWebhookSources", () => ({
  useWebhookSources: () => ({ data: { data: [] } }),
  usePipelines: () => ({
    data: { data: [] },
    refetch: async () => ({ data: { data: [] } }),
  }),
}));

// O Radix (Sheet e Select) exige estes recursos do navegador, que o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import { CapturaDetail } from "@/app/app/webhooks/_components/CapturaDetail";

/** Toda quebra forçada aceita pelo projeto. `wrap-anywhere` é a preferida. */
const QUEBRA_FORCADA = /(?:\bwrap-anywhere\b|\bbreak-words\b|\bbreak-all\b)/;
/** Quebra que também REDUZ o min-content — a única que vence trilha de teto fixo. */
const QUEBRA_QUE_ENCOLHE = /(?:\bwrap-anywhere\b|\bbreak-all\b)/;
/** O que apaga o texto em vez de quebrá-lo: proibido no rótulo (#3014). */
const CORTA = /(?:\boverflow-hidden\b|\btruncate\b)/;

/** A chave crua que o formulário mandou: uma palavra só, sem espaço. */
const ROTULO_LONGO = "disposto_investir_1500_reais_por_mes_em_trafego";
/** O outro formato que o #3014 cita: chave UUID de pergunta. */
const CHAVE_UUID = "3f9c1b2a-7d4e-4a51-9c60-1e2f3a4b5c6d";

function captura(fields: Record<string, unknown>): LeadCaptureRow {
  return {
    id: "c1",
    received_at: "2026-09-30T20:00:00Z",
    source_name: "Site",
    webhook_source_id: "00000000-0000-4000-8000-0000000000f1",
    lead_id: null,
    contact_id: null,
    outcome: "criado",
    reject_reason: null,
    captured_name: "Maria Teste",
    captured_phone: "+551****7777",
    captured_email: "maria.teste@example.com",
    fields,
    utm: {},
    remote_ip: null,
    user_agent: null,
    origin: null,
  };
}

function abrir(fields: Record<string, unknown>) {
  return render(
    <IdiomaProvider locale="pt-BR">
      <CapturaDetail captura={captura(fields)} onOpenChange={() => {}} />
    </IdiomaProvider>,
  );
}

/** O `<dt>` do rótulo — e a guarda de vacuidade que o nomeia. */
function dtDoRotulo(rotulo: string): HTMLElement {
  const el = screen.getByText(rotulo);
  expect(el.tagName, `o rótulo "${rotulo}" não é um <dt> (achei <${el.tagName.toLowerCase()}>)`).toBe(
    "DT",
  );
  return el;
}

describe("detalhe da captação — rótulo longo não cobre o valor (#3014)", () => {
  it("chave longa sem espaço: o <dt> carrega quebra forçada que encolhe a célula", () => {
    abrir({ [ROTULO_LONGO]: "sim" });

    const dt = dtDoRotulo(ROTULO_LONGO);
    expect(
      dt.className,
      "sem quebra no <dt>, a palavra de 40+ caracteres vaza da trilha de 7rem e é pintada por cima do valor",
    ).toMatch(QUEBRA_FORCADA);
    // `break-words` (overflow-wrap: break-word) NÃO reduz o min-content: numa
    // trilha de teto fixo o rótulo ainda pede a largura toda. Só `anywhere`
    // (ou `break-all`) encolhe o mínimo e faz o texto cair dentro da célula.
    expect(
      dt.className,
      "quebra fraca: `overflow-wrap: break-word` quebra na pintura mas não reduz o min-content",
    ).toMatch(QUEBRA_QUE_ENCOLHE);
    // O contrato é explícito: cortar torna o rótulo ilegível. Quebre, não esconda.
    expect(
      dt.className,
      "o rótulo foi CORTADO em vez de quebrado — o #3014 pede que ele continue legível",
    ).not.toMatch(CORTA);
  });

  it("chave UUID de pergunta também quebra — não é só o caso snake_case", () => {
    abrir({ [CHAVE_UUID]: "resposta" });

    const dt = dtDoRotulo(CHAVE_UUID);
    expect(dt.className).toMatch(QUEBRA_QUE_ENCOLHE);
    expect(dt.className).not.toMatch(CORTA);
  });

  it("CONTROLE — rótulo curto: a classe é a mesma (não é condicional) e a trilha não mudou", () => {
    abrir({ [ROTULO_LONGO]: "sim" });

    const dtLongo = dtDoRotulo(ROTULO_LONGO);
    const dtCurto = dtDoRotulo("Nome");

    // Estática, não "depende do tamanho": o rótulo curto recebe EXATAMENTE a
    // mesma classe. Se alguém tornar a quebra condicional ao comprimento, o
    // rótulo curto muda de classe e este caso reprova.
    expect(
      dtCurto.className,
      "a quebra do rótulo virou condicional ao tamanho do texto — o rótulo curto perdeu a regra",
    ).toBe(dtLongo.className);

    // A hierarquia visual e o par rótulo/valor seguem os de antes: sem isso o
    // conserto "quebraria o alinhamento das linhas normais".
    for (const c of ["text-xs", "text-muted-foreground"]) {
      expect(dtCurto.className, `o <dt> perdeu \`${c}\``).toContain(c);
    }

    const linha = dtCurto.parentElement as HTMLElement;
    expect(linha.className, "o grid de duas colunas do par rótulo/valor mudou").toContain(
      "grid-cols-[minmax(0,7rem)_1fr]",
    );
    const dd = linha.querySelector("dd") as HTMLElement;
    expect(dd, "o valor do par rótulo/valor sumiu").toBeTruthy();
    expect(dd.className, "o <dd> do valor perdeu o `min-w-0`/quebra que já tinha").toContain(
      "min-w-0",
    );
    expect(dd.className).toMatch(QUEBRA_FORCADA);
  });
});
