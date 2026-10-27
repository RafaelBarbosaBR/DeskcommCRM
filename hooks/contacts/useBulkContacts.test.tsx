/**
 * O toast do lote parcial concorda em número (#2484, F3). A prova pela tela do
 * #2913 mediu "1 atualizados, 1 recusados.".
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";

import { useBulkContacts, type RelatorioDoLote } from "./useBulkContacts";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: vi.fn() } }));

function relatorio(feitos: number, recusados: number): { data: RelatorioDoLote } {
  const resultados = [
    ...Array.from({ length: feitos }, (_, i) => ({ id: `f-${i}`, feito: true })),
    ...Array.from({ length: recusados }, (_, i) => ({ id: `r-${i}`, feito: false, motivo: "Fora." })),
  ];
  return {
    data: { acao: "tag", teto: 100, total: feitos + recusados, feitos, recusados, resultados },
  };
}

async function rodar(feitos: number, recusados: number) {
  vi.mocked(apiClient.post).mockResolvedValueOnce(relatorio(feitos, recusados));
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useBulkContacts(), { wrapper });
  result.current.mutate({ ids: ["x"], action: "tag", op: "add", tag: "vip" });
  await waitFor(() => expect(toast.warning).toHaveBeenCalled());
  return vi.mocked(toast.warning).mock.calls[0]?.[0];
}

beforeEach(() => vi.clearAllMocks());

describe("toast do lote parcial", () => {
  it("1 e 1: singular dos dois lados", async () => {
    expect(await rodar(1, 1)).toBe("1 atualizado, 1 recusado.");
  });

  it("2 e 3: plural dos dois lados", async () => {
    expect(await rodar(2, 3)).toBe("2 atualizados, 3 recusados.");
  });

  it("0 e 1: zero leva o plural", async () => {
    expect(await rodar(0, 1)).toBe("0 atualizados, 1 recusado.");
  });
});
