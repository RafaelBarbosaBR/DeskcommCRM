import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { ApiError } from "@/lib/api/types";
import { VinculoDaMarcacao } from "./VinculoDaMarcacao";

/**
 * "CRIAR NOVO CONTATO" INLINE — buscar um cliente não cadastrado na marcação
 * antes só devolvia lista vazia, sem caminho: quem estava marcando tinha que
 * sair pra Contatos, criar, e voltar torcendo pra lembrar o que preenchia
 * (Onda 3, item 3.4). A rota de busca (`/api/v1/agenda/vinculos`) procura só
 * por NOME (`ilike`), então o gatilho é "buscou e não achou".
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));

let client: QueryClient;

function renderTela(onChange = vi.fn()) {
  render(
    <QueryClientProvider client={client}>
      <IdiomaProvider locale="pt-BR">
        <VinculoDaMarcacao contactId="" conversationId="" onChange={onChange} />
      </IdiomaProvider>
    </QueryClientProvider>,
  );
  return onChange;
}

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  cleanup();
  client.clear();
});

describe("VinculoDaMarcacao — criar contato inline", () => {
  it("busca sem match oferece criar, pré-preenchido com o que foi digitado", async () => {
    api.get.mockResolvedValue({ data: { contacts: [], conversations: [] } });
    renderTela();

    fireEvent.change(screen.getByLabelText("Buscar cliente"), { target: { value: "Maria Inexistente" } });

    await screen.findByTestId("criar-contato-inline");
    expect(screen.getByLabelText("Nome do novo contato")).toHaveValue("Maria Inexistente");
  });

  it("caixa vazia não oferece criar (não é 'ninguém cadastrado' pra todo mundo que abre o painel)", async () => {
    api.get.mockResolvedValue({ data: { contacts: [], conversations: [] } });
    renderTela();

    await screen.findByLabelText("Quem será atendido");
    expect(screen.queryByTestId("criar-contato-inline")).not.toBeInTheDocument();
  });

  it("existe contato com esse nome: NÃO oferece criar", async () => {
    api.get.mockResolvedValue({ data: { contacts: [{ id: "c1", name: "Maria Silva" }], conversations: [] } });
    renderTela();

    fireEvent.change(screen.getByLabelText("Buscar cliente"), { target: { value: "Maria" } });

    await screen.findByText("Maria Silva");
    expect(screen.queryByTestId("criar-contato-inline")).not.toBeInTheDocument();
  });

  it("criar com sucesso: POST com nome+telefone, e onChange vincula o novo contato", async () => {
    api.get.mockResolvedValue({ data: { contacts: [], conversations: [] } });
    api.post.mockResolvedValue({ data: { id: "novo-contato-1" } });
    const onChange = renderTela();

    fireEvent.change(screen.getByLabelText("Buscar cliente"), { target: { value: "Maria Inexistente" } });
    await screen.findByTestId("criar-contato-inline");
    fireEvent.change(screen.getByLabelText("Telefone do novo contato"), { target: { value: "+5511999998888" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar contato" }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith("/api/v1/contacts", {
        name: "Maria Inexistente",
        phone_number: "+5511999998888",
      });
    });
    expect(onChange).toHaveBeenCalledWith("novo-contato-1", "");
  });

  it("telefone já cadastrado (409 contact_exists): vincula ao contato existente, não falha morto", async () => {
    api.get.mockResolvedValue({ data: { contacts: [], conversations: [] } });
    api.post.mockRejectedValue(
      new ApiError(409, "contact_exists", { contact_id: "contato-ja-existe" }, "req-1", "Já existe."),
    );
    const onChange = renderTela();

    fireEvent.change(screen.getByLabelText("Buscar cliente"), { target: { value: "Maria Inexistente" } });
    await screen.findByTestId("criar-contato-inline");
    fireEvent.click(screen.getByRole("button", { name: "Criar contato" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith("contato-ja-existe", "");
    });
  });
});
