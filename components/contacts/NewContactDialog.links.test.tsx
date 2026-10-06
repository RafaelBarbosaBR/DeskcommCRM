/**
 * O diálogo de novo contato ganhou um jeito de preencher links (Instagram,
 * site…) na hora de cadastrar — antes só dava para editar depois, na aba
 * "Links" do dossiê do negócio (`ContatoDoNegocio.tsx`).
 *
 * Os campos ficam ESCONDIDOS por padrão (a maioria dos contatos nasce sem
 * links), e o corpo do `POST /api/v1/contacts` só carrega `custom_fields`
 * quando pelo menos um link válido foi digitado.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NewContactDialog } from "@/components/contacts/NewContactDialog";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ currency: "BRL", country: null }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

function envolver(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ data: { contact: { id: "ct-1", custom_fields: {} }, action: "created" } }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function corpoEnviado() {
  const chamada = fetchMock.mock.calls[0];
  const init = chamada?.[1] as RequestInit;
  return JSON.parse(init.body as string);
}

describe("NewContactDialog · links e redes sociais", () => {
  it("⭐ os campos de link ficam escondidos até o clique em 'Links e redes sociais'", () => {
    envolver(<NewContactDialog open onOpenChange={vi.fn()} />);
    expect(screen.queryByLabelText("Instagram")).not.toBeInTheDocument();

    void userEvent.setup();
  });

  it("⭐ preencher um link válido manda custom_fields no corpo da criação", async () => {
    const user = userEvent.setup();
    envolver(<NewContactDialog open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText(/Telefone/i), "+5511999998888");
    await user.click(screen.getByRole("button", { name: "+ Links e redes sociais" }));
    await user.type(screen.getByLabelText("Instagram"), "instagram.com/loja");

    await user.click(screen.getByRole("button", { name: /Criar contato/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const corpo = corpoEnviado();
    expect(corpo.custom_fields).toEqual({ link_instagram: "instagram.com/loja" });
  });

  it("não manda custom_fields quando nenhum link foi preenchido", async () => {
    const user = userEvent.setup();
    envolver(<NewContactDialog open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText(/Telefone/i), "+5511999998888");
    await user.click(screen.getByRole("button", { name: /Criar contato/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(corpoEnviado()).not.toHaveProperty("custom_fields");
  });

  it("⭐ link inválido recusa o envio inteiro, com a conta do número de fetches provando que não há criação parcial", async () => {
    const user = userEvent.setup();
    envolver(<NewContactDialog open onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText(/Telefone/i), "+5511999998888");
    await user.click(screen.getByRole("button", { name: "+ Links e redes sociais" }));
    await user.type(screen.getByLabelText("Instagram"), "javascript:alert(1)");

    await user.click(screen.getByRole("button", { name: /Criar contato/i }));

    expect(await screen.findByText("Endereço inválido.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
