import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { AgendaClient } from "@/app/app/agenda/_client";

/**
 * "NOVO AGENDAMENTO" NÃO PODE VIR COM O CLIENTE DA VEZ ANTERIOR.
 *
 * Achado no changelog do upstream (v1.23.0): quem abre "Marcar compromisso" a
 * partir de uma conversa (`?contato=&conversa=` na URL) e depois fecha o
 * painel SEM confirmar via o botão avulso "Novo agendamento" da barra de
 * ferramentas encontrava "Quem será atendido" pré-preenchido com aquele
 * cliente — o `onOpenChange` do Sheet já resetava `remarcandoId`/
 * `horarioEscolhido`/`emailConvidado` ao fechar, mas esquecia `contactId`/
 * `conversationId`.
 *
 * Os componentes pesados da tela (grade interativa, histórico, filtro de
 * pessoas, EntradaDaAgenda de verdade) são substituídos por dublês — o que
 * está sob teste é só a amarração Sheet↔estado, não a agenda inteira.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));

let onContextRef: ((contact: string, conversation: string) => void) | null = null;
vi.mock("@/components/agenda/EntradaDaAgenda", () => ({
  EntradaDaAgenda: ({ onContext }: { onContext: (contact: string, conversation: string) => void }) => {
    onContextRef = onContext;
    return null;
  },
}));
vi.mock("@/components/agenda/AgendaInterativa", () => ({ AgendaInterativa: () => null }));
vi.mock("@/components/agenda/HistoricoDaAgenda", () => ({ HistoricoDaAgenda: () => null }));
vi.mock("@/components/agenda/FiltroDePessoas", () => ({ FiltroDePessoas: () => null }));
vi.mock("../../app/app/agenda/_components/AvisoDaConexaoGoogle", () => ({ AvisoDaConexaoGoogle: () => null }));
vi.mock("../../app/app/agenda/_components/CartaoDaConexaoGoogle", () => ({ CartaoDaConexaoGoogle: () => null }));

vi.mock("@/hooks/agenda/usePessoasDaAgenda", () => ({
  usePessoasDaAgenda: () => ({ data: [] }),
}));
vi.mock("@/hooks/agenda/useHorariosLivres", () => ({
  useHorariosLivres: () => ({ data: undefined, isError: false }),
}));
vi.mock("@/hooks/agenda/useAgendamentos", () => ({
  useAgendamentos: () => ({ data: [] }),
}));
vi.mock("@/hooks/agenda/useMarcarAgendamento", () => ({
  useMarcarAgendamento: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/agenda/useRemarcarAgendamento", () => ({
  useRemarcarAgendamento: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCancelarAgendamento: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRegistrarDesfecho: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

let client: QueryClient;

function renderTela() {
  return render(
    <QueryClientProvider client={client}>
      <IdiomaProvider locale="pt-BR">
        <AgendaClient
          fusoDeApresentacao="America/Sao_Paulo"
          googleConfigurado={false}
          faltaNoGoogle={[]}
          tiposIniciais={[
            { id: "tipo-1", nome: "Consulta", duracaoMin: 30, donoId: "user-1", localKind: "presencial", localDetalhes: null },
          ]}
          agendamentosIniciais={[]}
        />
      </IdiomaProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  onContextRef = null;
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  api.get.mockResolvedValue({ data: { contacts: [{ id: "contact-xyz", name: "Fulano" }], conversations: [] } });
});

afterEach(() => {
  cleanup();
  client.clear();
});

describe('"Novo agendamento" não herda o cliente da vez anterior', () => {
  it("abrir a partir de uma conversa, fechar sem confirmar, e abrir avulso: Quem será atendido volta vazio", async () => {
    renderTela();

    // Simula chegar com ?contato=&conversa= na URL (o dublê de EntradaDaAgenda
    // expõe o onContext real que o componente de verdade chamaria).
    expect(onContextRef).not.toBeNull();
    act(() => {
      onContextRef!("contact-xyz", "conv-xyz");
    });

    // O `<select>` só reflete `contactId` de verdade depois que a opção
    // correspondente chega da API (um `value` sem `<option>` cai pra "" no
    // DOM) — por isso espera a opção "Fulano" aparecer antes de checar.
    await screen.findByRole("option", { name: "Fulano" });
    const select = await screen.findByLabelText("Quem será atendido");
    expect(select).toHaveValue("contact-xyz");

    // Fecha o Sheet SEM confirmar — pelo botão "Close" do próprio SheetContent
    // (o `sr-only` do X), o mesmo que o usuário clica ou o Escape aciona por
    // baixo dos panos via Radix.
    const botaoFechar = screen.getByRole("button", { name: "Close" });
    act(() => {
      fireEvent.click(botaoFechar);
    });
    await waitFor(() => {
      expect(screen.queryByLabelText("Quem será atendido")).not.toBeInTheDocument();
    });

    // Reabre pelo botão avulso da barra de ferramentas.
    const botaoNovo = screen.getByRole("button", { name: "Novo agendamento" });
    act(() => {
      fireEvent.click(botaoNovo);
    });

    const selectDeNovo = await screen.findByLabelText("Quem será atendido");
    expect(selectDeNovo).toHaveValue("");
  });
});
