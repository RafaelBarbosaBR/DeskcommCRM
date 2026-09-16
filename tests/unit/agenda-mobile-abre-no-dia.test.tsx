import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { AgendaClient } from "@/app/app/agenda/_client";

/**
 * NO CELULAR, A AGENDA ABRE NO DIA — NÃO NA SEMANA ESPREMIDA.
 *
 * Achado no changelog do upstream (Onda 3, item 3.3): `useState<VisaoDaAgenda>("semana")`
 * sempre, mesmo num viewport de ~375px — 7 colunas flex nessa largura ficam
 * com ~45px cada, sem espaço nem para o horário. `GradeDaAgenda.tsx` já
 * renderiza corretamente uma coluna larga para "dia" (é flexbox, não um grid
 * fixo de 7 colunas — a suspeita original do changelog não se confirmou ao
 * ler o arquivo); o que faltava era só o ESTADO inicial.
 *
 * O ajuste troca o estado DEPOIS de montar (não lendo `window` dentro do
 * `useState`), pelo mesmo motivo já registrado em `InboxLayout.tsx`: ler
 * `window` na inicialização hidrataria com valor diferente do servidor.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));

vi.mock("@/components/agenda/EntradaDaAgenda", () => ({ EntradaDaAgenda: () => null }));
vi.mock("@/components/agenda/AgendaInterativa", () => ({ AgendaInterativa: () => null }));
vi.mock("@/components/agenda/HistoricoDaAgenda", () => ({ HistoricoDaAgenda: () => null }));
vi.mock("@/components/agenda/FiltroDePessoas", () => ({ FiltroDePessoas: () => null }));
vi.mock("../../app/app/agenda/_components/AvisoDaConexaoGoogle", () => ({ AvisoDaConexaoGoogle: () => null }));
vi.mock("../../app/app/agenda/_components/CartaoDaConexaoGoogle", () => ({ CartaoDaConexaoGoogle: () => null }));

vi.mock("@/hooks/agenda/usePessoasDaAgenda", () => ({ usePessoasDaAgenda: () => ({ data: [] }) }));
vi.mock("@/hooks/agenda/useHorariosLivres", () => ({
  useHorariosLivres: () => ({ data: undefined, isError: false }),
}));
vi.mock("@/hooks/agenda/useAgendamentos", () => ({ useAgendamentos: () => ({ data: [] }) }));
vi.mock("@/hooks/agenda/useMarcarAgendamento", () => ({
  useMarcarAgendamento: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/agenda/useRemarcarAgendamento", () => ({
  useRemarcarAgendamento: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCancelarAgendamento: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRegistrarDesfecho: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

let client: QueryClient;

function mockViewport(estreita: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: estreita,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

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
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  api.get.mockResolvedValue({ data: { contacts: [], conversations: [] } });
});

afterEach(() => {
  cleanup();
  client.clear();
});

describe("visão inicial da agenda conforme o viewport", () => {
  it("viewport estreito (<768px): troca para 'dia' logo após montar", async () => {
    mockViewport(true);
    renderTela();

    await waitFor(() => {
      expect(screen.getByTestId("visao-dia")).toHaveAttribute("aria-pressed", "true");
    });
    expect(screen.getByTestId("visao-semana")).toHaveAttribute("aria-pressed", "false");
  });

  it("viewport largo (>=768px): continua abrindo em 'semana', como sempre", async () => {
    mockViewport(false);
    renderTela();

    await screen.findByTestId("visao-semana");
    expect(screen.getByTestId("visao-semana")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("visao-dia")).toHaveAttribute("aria-pressed", "false");
  });
});
