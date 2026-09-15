import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { DetalheDoCompromisso } from "@/components/agenda/DetalheDoCompromisso";

/**
 * PEDIDO PENDENTE GANHA UM BOTÃO "CONFIRMAR" PRÓPRIO.
 *
 * Achado no changelog do upstream: antes só existiam Compareceu/Faltou
 * (DESFECHO, depois do horário já ter passado) e Cancelar — não havia jeito
 * de simplesmente confirmar um pedido pendente sem esperar ele acontecer. O
 * back-end (`app/api/v1/agenda/agendamentos/route.ts`, `alterarSchema`) já
 * aceita `status: "confirmed"` desde sempre; faltava só o botão.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));

let client: QueryClient;

const DETALHE_PENDENTE = {
  id: "agend-1",
  title: "Consulta",
  starts_at: "2026-09-20T13:00:00.000Z",
  ends_at: "2026-09-20T13:30:00.000Z",
  time_zone: "America/Sao_Paulo",
  status: "pending",
  revision: 1,
  contact_id: null,
  conversation_id: null,
  outcome_source_kind: null,
  outcome_recorded_at: null,
  recovery: null,
  evidence_messages: [],
};

function renderTela() {
  return render(
    <QueryClientProvider client={client}>
      <IdiomaProvider locale="pt-BR">
        <DetalheDoCompromisso id="agend-1" onClose={() => {}} />
      </IdiomaProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  api.get.mockResolvedValue({ data: DETALHE_PENDENTE });
  api.patch.mockResolvedValue({ data: { ...DETALHE_PENDENTE, status: "confirmed", revision: 2 } });
});

afterEach(() => {
  cleanup();
  client.clear();
});

describe('"Confirmar" no pedido pendente', () => {
  it("clicar em Confirmar manda status: confirmed pro PATCH", async () => {
    renderTela();

    const botao = await screen.findByRole("button", { name: "Confirmar" });
    fireEvent.click(botao);

    await waitFor(() => {
      expect(api.patch).toHaveBeenCalledWith(
        "/api/v1/agenda/agendamentos",
        expect.objectContaining({ id: "agend-1", status: "confirmed" }),
      );
    });
  });

  it("compromisso já confirmado não mostra o botão", async () => {
    api.get.mockResolvedValue({ data: { ...DETALHE_PENDENTE, status: "confirmed" } });
    renderTela();

    await screen.findByTestId("compromisso-horario");
    expect(screen.queryByRole("button", { name: "Confirmar" })).not.toBeInTheDocument();
  });
});
