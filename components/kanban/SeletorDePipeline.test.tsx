/**
 * O menu que troca de pipeline sem voltar para `/app/kanban` (issue 16/10).
 *
 * Por que isto tem teste: a regra de aparecer só com 2+ pipelines é fácil de
 * inverter por acidente (`< 2` vira `> 2`, ou o `return null` sai do lugar) e
 * o sintoma — o botão sempre lá, ou nunca lá — não aparece em nenhum outro
 * teste da página.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { SeletorDePipeline } from "@/components/kanban/SeletorDePipeline";

describe("seletor de pipeline no cabeçalho do quadro", () => {
  it("não renderiza nada quando só existe um pipeline", () => {
    render(<SeletorDePipeline pipelineId="p-1" pipelines={[{ id: "p-1", name: "Vendas" }]} />);
    expect(screen.queryByTestId("seletor-de-pipeline")).not.toBeInTheDocument();
  });

  it("não renderiza nada quando a lista vem vazia", () => {
    render(<SeletorDePipeline pipelineId="p-1" pipelines={[]} />);
    expect(screen.queryByTestId("seletor-de-pipeline")).not.toBeInTheDocument();
  });

  it("com 2+ pipelines, lista todos como links e marca o atual", async () => {
    const user = userEvent.setup();
    render(
      <SeletorDePipeline
        pipelineId="p-1"
        pipelines={[
          { id: "p-1", name: "Vendas" },
          { id: "p-2", name: "Suporte" },
        ]}
      />,
    );
    await user.click(screen.getByTestId("seletor-de-pipeline"));

    // Radix dá `role="menuitem"` ao `<a>`, não "link" — a acessibilidade do
    // menu é a de um menu, mesmo sendo navegação de verdade por baixo.
    const vendas = await screen.findByRole("menuitem", { name: /Vendas/ });
    const suporte = await screen.findByRole("menuitem", { name: "Suporte" });
    expect(vendas).toHaveAttribute("href", "/app/pipelines/p-1");
    expect(suporte).toHaveAttribute("href", "/app/pipelines/p-2");
    // Só o atual leva o ícone de marcado — é o que diferencia "é esta a tela
    // que eu já estou vendo" de um link igual aos outros.
    expect(vendas.querySelector("svg")).toBeTruthy();
    expect(suporte.querySelector("svg")).toBeFalsy();
  });
});
