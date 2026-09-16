import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { FechamentosDaAgenda } from "./FechamentosDaAgenda";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));

let client: QueryClient;

function renderTela() {
  return render(
    <QueryClientProvider client={client}>
      <IdiomaProvider locale="pt-BR">
        <FechamentosDaAgenda />
      </IdiomaProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  cleanup();
  client.clear();
});

describe("FechamentosDaAgenda", () => {
  it("preencher data + motivo e enviar chama a API com o payload certo", async () => {
    api.get.mockResolvedValue({ data: [] });
    api.post.mockResolvedValue({ data: { id: "exc-1" } });
    renderTela();

    await screen.findByText("Nenhum dia fechado.");
    fireEvent.change(screen.getByLabelText("Data"), { target: { value: "2026-12-25" } });
    fireEvent.change(screen.getByLabelText("Motivo (opcional)"), { target: { value: "Natal" } });
    fireEvent.click(screen.getByRole("button", { name: "Fechar este dia" }));

    await vi.waitFor(() => {
      expect(api.post).toHaveBeenCalledWith("/api/v1/agenda/excecoes", {
        exception_date: "2026-12-25",
        is_unavailable: true,
        reason: "Natal",
      });
    });
  });

  it("lista as exceções existentes e remove ao clicar", async () => {
    api.get.mockResolvedValue({
      data: [{ id: "exc-1", exception_date: "2026-12-25", is_unavailable: true, start_minute: 0, end_minute: 1440, reason: "Natal" }],
    });
    api.delete.mockResolvedValue({ data: { id: "exc-1" } });
    renderTela();

    await screen.findByTestId("excecao-exc-1");
    fireEvent.click(screen.getByRole("button", { name: "Remover" }));

    await vi.waitFor(() => {
      expect(api.delete).toHaveBeenCalledWith("/api/v1/agenda/excecoes", { id: "exc-1" });
    });
  });
});
