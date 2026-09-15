import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { FlowsList } from "@/app/app/ai/followups/_components/FlowsList";
import { NewFlowDialog } from "@/app/app/ai/followups/_components/NewFlowDialog";
import type { FollowupFlowPointerRow } from "@/hooks/followup/useFollowupFlows";

/**
 * O HUB DE IA NÃO PODE FICAR EM PORTUGUÊS COM O IDIOMA EM ESPANHOL.
 *
 * Achado no changelog do upstream: "Fila" (aba de `followups/page.tsx`),
 * "Handoff"/"publicada"/"Atualizado em" (`FlowsList.tsx`) e "Nome"
 * (`NewFlowDialog.tsx`) eram texto cru, fora de `t()` — uma conta em espanhol
 * via a tela de follow-ups inteira em português trocado só pela metade.
 *
 * `tests/unit/i18n-espanhol-cobre-a-tela.test.ts` prova que toda `t()`
 * CHAMADA tem entrada em espanhol; não prova que uma string que nunca passou
 * por `t()` deveria ter passado. Este teste é o par que falta: renderiza com
 * `locale="es"` e afirma que o texto que aparece é o espanhol, não o
 * português hardcoded.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));

let client: QueryClient;

const FLOW: FollowupFlowPointerRow = {
  id: "flow-1",
  name: "Recuperação de carrinho",
  status: "active",
  active_version_id: "v1",
  handoff_policy: "manual",
  updated_at: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  cleanup();
  client.clear();
});

function renderEs(node: React.ReactElement) {
  return render(
    <QueryClientProvider client={client}>
      <IdiomaProvider locale="es">{node}</IdiomaProvider>
    </QueryClientProvider>,
  );
}

describe("FlowsList em espanhol", () => {
  it("Handoff/Atualizado em saem traduzidos, não em português cru", async () => {
    renderEs(<FlowsList initialData={[FLOW]} canWrite={false} />);

    await screen.findByText(FLOW.name);
    // Os rótulos hardcoded ANTES do fix — se reaparecerem, é regressão.
    // ("publicada" fica de fora deste teste: em espanhol a palavra é
    // idêntica, então checá-la aqui não distinguiria certo de errado.)
    expect(screen.queryByText("Handoff", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText("Transferencia", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText(/^Atualizado em /)).not.toBeInTheDocument();
    expect(screen.getByText(/^Actualizado el /)).toBeInTheDocument();
  });
});

describe("NewFlowDialog em espanhol", () => {
  it('o rótulo do campo não fica "Nome" em português — sai "Nombre"', () => {
    renderEs(<NewFlowDialog open onOpenChange={() => {}} />);

    expect(screen.queryByText("Nome", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText("Nombre", { exact: true })).toBeInTheDocument();
  });
});
