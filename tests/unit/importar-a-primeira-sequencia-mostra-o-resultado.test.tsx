/**
 * A PRIMEIRA SEQUÊNCIA IMPORTADA MOSTRA O RESULTADO.
 *
 * A janela de importação mostra, depois de importar, o que resolver antes de publicar e o link
 * « Abrir o fluxo » (o teste do próprio diálogo cobra isso). Na tela de verdade, com a lista VAZIA,
 * o resultado sumia: ao importar, a lista passa de 0 para 1 sequência, e a `FlowsList` desenhava os
 * diálogos num ramo diferente para cada caso — dentro da <div> da lista num, ao lado do cartão vazio
 * no outro. O React remontava o diálogo e perdia o estado; a pessoa via só o toast. Medido pela tela,
 * importando um arquivo cujo gatilho aponta para uma etapa que a conta não tem.
 *
 * O que se cobra: importar com a lista vazia e redesenhar a tela com a lista já com a sequência — o
 * que o servidor faz em seguida — mantém o resultado e o link na tela.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FollowupFlowPointerRow } from "@/hooks/followup/useFollowupFlows";

const h = vi.hoisted(() => ({
  lista: [] as unknown[],
  importar: vi.fn(),
  mutacao: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/followup/useFollowupFlows", () => ({
  useFollowupFlows: () => ({ data: h.lista }),
  useImportFollowupFlow: () => ({ mutate: h.importar, isPending: false }),
  useCreateFollowupFlow: h.mutacao,
  useDuplicateFollowupFlow: h.mutacao,
  useExportFollowupFlow: h.mutacao,
}));
vi.mock("@/hooks/followup/useFollowupFlow", () => ({ useDeleteFollowupFlow: h.mutacao, useRenameFollowupFlow: h.mutacao }));
vi.mock("@/hooks/followup/useInstalarModelo", () => ({ useInstalarModelo: h.mutacao }));
vi.mock("@/hooks/followup/useEtapasDeGatilho", () => ({ useEtapasDeGatilho: () => ({ etapas: [], carregando: false }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));

import { FlowsList } from "@/app/app/ai/followups/_components/FlowsList";

const FLUXO: FollowupFlowPointerRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Relance devis",
  status: "draft",
  active_version_id: null,
  handoff_policy: "pause",
  updated_at: "2026-10-19T12:00:00Z",
} as FollowupFlowPointerRow;

function tela() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <FlowsList initialData={[]} canWrite />
    </QueryClientProvider>
  );
}

describe("a primeira sequência importada", () => {
  beforeEach(() => {
    h.lista = [];
    h.importar.mockReset();
    h.importar.mockImplementation((_vars: unknown, opts?: { onSuccess?: (d: unknown) => void }) =>
      opts?.onSuccess?.({
        flow: FLUXO,
        pendencias: [{ codigo: "gatilho_trocado_para_manual", bloqueia: true, referencia: "Devis envoyé · Pipeline Ventes" }],
      }),
    );
  });

  it("o resultado e o link continuam na tela quando a lista deixa de ser vazia", async () => {
    const user = userEvent.setup({ delay: null });
    const { rerender } = render(tela());
    await user.click(screen.getByRole("button", { name: "Importar fluxo" }));
    fireEvent.change(screen.getByLabelText("Ou cole o conteúdo do arquivo"), { target: { value: '{"format":"followup_flow"}' } });
    await user.click(screen.getByRole("button", { name: "Importar" }));
    expect(screen.getByRole("link", { name: "Abrir o fluxo" })).toBeTruthy();

    // O servidor devolve a lista com a sequência nova: a tela troca o cartão vazio pela lista.
    h.lista = [FLUXO];
    rerender(tela());

    expect(screen.getByRole("link", { name: "Abrir o fluxo" })).toBeTruthy();
    expect(screen.getByText(/voltou para Manual/)).toBeTruthy();
  });
});
