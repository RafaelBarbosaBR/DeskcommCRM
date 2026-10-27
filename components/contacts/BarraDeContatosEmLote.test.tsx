/**
 * A barra de ações do lote da tela de Contatos (#2484, fatia F3).
 *
 * O que este teste prende:
 *
 * 1. A barra SÓ EXISTE com seleção — `quantidade === 0` não renderiza nada.
 *    Uma barra permanente acima da tabela é ruído que o olho aprende a
 *    ignorar, e ela mora justamente onde ficam as ações de risco.
 * 2. Cada ação delega o que a barra tem em mãos — a barra não sabe de ids nem
 *    de organização: ela só escolhe a ação e passa os parâmetros.
 * 3. O "Mudar responsável" escolhe o dono e devolve o `user_id` — quem monta o
 *    lote manda para a rota, que valida o dono um a um (o mesmo contrato da
 *    rota individual de carteira).
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { contrasteNoTema, tokenDaClasse } from "@/tests/setup/contraste-do-utilitario";

import { BarraDeContatosEmLote } from "./BarraDeContatosEmLote";

// Polyfills que o Radix Select exige e o jsdom não tem (mesmo padrão de
// components/kanban/MoveToOtherPipelineDialog.test.tsx).
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({
    data: [{ user_id: "user-dono-1", role: "agent", full_name: "Bruno" }],
    isLoading: false,
  }),
}));

function mao() {
  return {
    onAdicionarEtiqueta: vi.fn(),
    onRemoverEtiqueta: vi.fn(),
    onMudarResponsavel: vi.fn(),
    onPreencherCampo: vi.fn(),
    onLimpar: vi.fn(),
  };
}

describe("BarraDeContatosEmLote", () => {
  it("sem seleção, a barra não existe", () => {
    render(<BarraDeContatosEmLote quantidade={0} pendente={false} {...mao()} />);
    expect(screen.queryByTestId("barra-de-contatos-em-lote")).toBeNull();
  });

  it("com 3 selecionados, a barra aparece com a contagem", () => {
    render(<BarraDeContatosEmLote quantidade={3} pendente={false} {...mao()} />);
    expect(screen.getByTestId("barra-de-contatos-em-lote")).toBeInTheDocument();
    expect(screen.getByText("3 contatos selecionados")).toBeInTheDocument();
  });

  it("a contagem passa 4.5:1 sobre o fundo da barra nos dois temas", () => {
    render(<BarraDeContatosEmLote quantidade={3} pendente={false} {...mao()} />);
    // Medido na prova do #2913 com `text-text-muted` sobre `bg-surface-elevated`:
    // 4.44:1 no escuro, em texto de 12px.
    const barra = screen.getByTestId("barra-de-contatos-em-lote");
    const fundo = tokenDaClasse(barra.className, "bg");
    const frente = tokenDaClasse(screen.getByText("3 contatos selecionados").className, "text");
    for (const tema of ["claro", "escuro"] as const) {
      expect(contrasteNoTema(frente, fundo, tema), `${frente} sobre ${fundo} no ${tema}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("adicionar etiqueta: escreve, confirma e delega a etiqueta aparada", async () => {
    const user = userEvent.setup();
    const h = mao();
    render(<BarraDeContatosEmLote quantidade={2} pendente={false} {...h} />);

    await user.click(screen.getByTestId("lote-mais-acoes"));
    await user.click(screen.getByTestId("lote-adicionar-etiqueta"));
    await user.type(screen.getByTestId("lote-tag-input"), "  atraso  ");
    await user.click(screen.getByTestId("lote-tag-confirmar"));

    expect(h.onAdicionarEtiqueta).toHaveBeenCalledWith("atraso");
    // O diálogo fecha e o campo esvazia: a próxima ação não herda a anterior.
    expect(screen.queryByTestId("lote-tag-confirmar")).toBeNull();
  });

  it("remover etiqueta delega pelo caminho do remover, e não do adicionar", async () => {
    const user = userEvent.setup();
    const h = mao();
    render(<BarraDeContatosEmLote quantidade={1} pendente={false} {...h} />);

    await user.click(screen.getByTestId("lote-mais-acoes"));
    await user.click(screen.getByTestId("lote-remover-etiqueta"));
    await user.type(screen.getByTestId("lote-tag-input"), "vip");
    await user.click(screen.getByTestId("lote-tag-confirmar"));

    expect(h.onRemoverEtiqueta).toHaveBeenCalledWith("vip");
    expect(h.onAdicionarEtiqueta).not.toHaveBeenCalled();
  });

  it("mudar responsável: sem destino o confirmar fica desligado; escolhido, devolve o user_id", async () => {
    const user = userEvent.setup();
    const h = mao();
    render(<BarraDeContatosEmLote quantidade={2} pendente={false} {...h} />);

    await user.click(screen.getByTestId("lote-mais-acoes"));
    await user.click(screen.getByTestId("lote-mudar-responsavel"));
    expect(screen.getByTestId("lote-responsavel-confirmar")).toBeDisabled();

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "Bruno" }));
    await user.click(screen.getByTestId("lote-responsavel-confirmar"));

    expect(h.onMudarResponsavel).toHaveBeenCalledWith("user-dono-1");
  });

  it("sem onMudarResponsavel (papel abaixo de manager), o item não aparece", async () => {
    const user = userEvent.setup();
    const h = { ...mao(), onMudarResponsavel: undefined };
    render(<BarraDeContatosEmLote quantidade={2} pendente={false} {...h} />);

    await user.click(screen.getByTestId("lote-mais-acoes"));
    expect(screen.getByTestId("lote-adicionar-etiqueta")).toBeInTheDocument();
    expect(screen.queryByTestId("lote-mudar-responsavel")).toBeNull();
  });

  it("preencher campo personalizado: chave e valor juntos; sem chave, desligado", async () => {
    const user = userEvent.setup();
    const h = mao();
    render(<BarraDeContatosEmLote quantidade={1} pendente={false} {...h} />);

    await user.click(screen.getByTestId("lote-mais-acoes"));
    await user.click(screen.getByTestId("lote-preencher-campo"));
    expect(screen.getByTestId("lote-campo-confirmar")).toBeDisabled();

    await user.type(screen.getByTestId("lote-campo-chave"), "Andamento");
    await user.type(screen.getByTestId("lote-campo-valor"), "contrato enviado");
    await user.click(screen.getByTestId("lote-campo-confirmar"));

    expect(h.onPreencherCampo).toHaveBeenCalledWith("Andamento", "contrato enviado");
  });

  it("limpar seleção delega sem abrir diálogo nenhum", async () => {
    const user = userEvent.setup();
    const h = mao();
    render(<BarraDeContatosEmLote quantidade={4} pendente={false} {...h} />);

    await user.click(screen.getByTestId("lote-limpar"));

    expect(h.onLimpar).toHaveBeenCalledTimes(1);
    expect(h.onAdicionarEtiqueta).not.toHaveBeenCalled();
  });

  it("com o lote pendente, as ações ficam desligadas", () => {
    render(<BarraDeContatosEmLote quantidade={2} pendente {...mao()} />);
    expect(screen.getByTestId("lote-mais-acoes")).toBeDisabled();
  });
});
