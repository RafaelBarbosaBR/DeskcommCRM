/**
 * "Usada em" marca a chave que o Jev de fato usa, e qual é depende da ORIGEM
 * (#2964): via OpenRouter é a credencial OpenRouter da conversa, não a TypeSafe
 * que ficou cadastrada de antes. Marcar a errada levava a apagar a chave viva.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CredentialsList } from "./CredentialsList";
import type { CredentialRow } from "@/hooks/ai/useCredentials";

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../_actions", () => ({ refreshCredentialsView: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() } }));

const conferida = (over: Partial<CredentialRow>): CredentialRow => ({
  id: "c1",
  organization_id: "o1",
  provider: "typesafe",
  label: "Jev (TypeSafe AI)",
  api_key_last4: "cdef",
  validated_at: "2026-09-20T12:00:00.000Z",
  validation_error: null,
  models_available: ["jev-latest"],
  is_active: true,
  created_by: null,
  created_at: "2026-09-20T12:00:00.000Z",
  updated_at: "2026-09-20T12:00:00.000Z",
  ...over,
});

describe("CredentialsList — a chave do Jev segue a origem", () => {
  it("com o Jev pela OpenRouter, 'Usada em' fica na credencial OpenRouter, não na TypeSafe", () => {
    const linhas = [
      conferida({}),
      conferida({ id: "c2", provider: "openrouter", label: "Conversa (OpenRouter)", api_key_last4: "9876" }),
    ];
    api.get.mockResolvedValue({ data: linhas });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <CredentialsList
          initialData={linhas}
          canWrite
          usageMap={{}}
          jev={{ tarefas: ["Clima da conversa"], temIaPrincipal: true, origem: "openrouter" }}
        />
      </QueryClientProvider>,
    );

    const marcas = screen.getAllByTestId("credencial-usada-em");
    expect(marcas).toHaveLength(1);
    const cartao = marcas[0]!.closest("li");
    expect(cartao).toHaveTextContent("Conversa (OpenRouter)");
    expect(cartao).not.toHaveTextContent("Jev (TypeSafe AI)");
  });
});
