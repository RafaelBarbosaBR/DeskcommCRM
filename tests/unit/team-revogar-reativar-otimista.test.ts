/**
 * REVOGAR/DEVOLVER ACESSO É OTIMISTA — no mesmo molde de `useChangeRole` (G2-02).
 *
 * O sintoma relatado pelo upstream ("fica parado até recarregar a página") não
 * reproduz aqui: os dois hooks já chamavam `invalidateQueries` no `onSuccess`,
 * que já refaz o fetch sozinho — só que DEPOIS da rede responder. O que faltava
 * era só o intervalo entre o clique e essa resposta: sem otimismo, a linha
 * ficava com a cara de antes até a rede voltar, mesmo com o pedido certo.
 *
 * O que se prende: (a) o cache muda na hora do `mutate`, sem esperar a rede;
 * (b) um erro da rede DESFAZ a mudança — a linha volta pro estado anterior,
 * não fica presa numa mentira otimista.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const postSpy = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { post: (url: string, body: unknown) => postSpy(url, body) },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useReactivateMember } from "@/hooks/team/useReactivateMember";
import { useRevokeMember } from "@/hooks/team/useRevokeMember";
import type { TeamMember } from "@/hooks/team/useTeamMembers";

const MEMBERS_KEY = ["team", "members"] as const;

const ANA: TeamMember = {
  user_id: "u-ana",
  role: "agent",
  invited_at: null,
  accepted_at: "2026-01-01T00:00:00.000Z",
  revoked_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  email: "ana@example.com",
  full_name: "Ana",
  last_sign_in_at: null,
};

const BRUNO: TeamMember = { ...ANA, user_id: "u-bruno", revoked_at: "2026-02-01T00:00:00.000Z" };

function novoContexto(membros: TeamMember[]) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  qc.setQueryData(MEMBERS_KEY, { data: membros });
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return { qc, wrapper: Wrapper };
}

function linhaDe(qc: QueryClient, userId: string): TeamMember | undefined {
  return qc.getQueryData<{ data: TeamMember[] }>(MEMBERS_KEY)?.data.find((m) => m.user_id === userId);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useRevokeMember — otimista", () => {
  it("marca revoked_at no clique, ANTES de a rede responder", async () => {
    const { qc, wrapper } = novoContexto([ANA]);
    let resolvePost!: (v: unknown) => void;
    postSpy.mockReturnValue(new Promise((resolve) => (resolvePost = resolve)));

    const { result } = renderHook(() => useRevokeMember(), { wrapper });
    act(() => {
      result.current.mutate(ANA.user_id);
    });

    // Ainda sem resposta nenhuma do POST — e a linha já mudou.
    await waitFor(() => expect(linhaDe(qc, ANA.user_id)?.revoked_at).not.toBeNull());
    expect(postSpy, "o otimismo tem de rodar sem depender da rede já ter respondido").toHaveBeenCalled();

    resolvePost({ data: { user_id: ANA.user_id, revoked_at: new Date().toISOString() } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("erro da rede DESFAZ o otimismo — a linha volta a ativa", async () => {
    const { qc, wrapper } = novoContexto([ANA]);
    postSpy.mockRejectedValue(new Error("falhou"));

    const { result } = renderHook(() => useRevokeMember(), { wrapper });
    act(() => {
      result.current.mutate(ANA.user_id);
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(
      linhaDe(qc, ANA.user_id)?.revoked_at,
      "o erro devia ter desfeito o otimismo — sem isso a linha fica presa mostrando revogado sem ter revogado nada",
    ).toBeNull();
    expect(vi.mocked(showApiError)).toHaveBeenCalled();
  });
});

describe("useReactivateMember — otimista, espelho do revoke", () => {
  it("zera revoked_at no clique, ANTES de a rede responder", async () => {
    const { qc, wrapper } = novoContexto([BRUNO]);
    let resolvePost!: (v: unknown) => void;
    postSpy.mockReturnValue(new Promise((resolve) => (resolvePost = resolve)));

    const { result } = renderHook(() => useReactivateMember(), { wrapper });
    act(() => {
      result.current.mutate(BRUNO.user_id);
    });

    await waitFor(() => expect(linhaDe(qc, BRUNO.user_id)?.revoked_at).toBeNull());

    resolvePost({ data: { user_id: BRUNO.user_id, reactivated_at: new Date().toISOString() } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("erro da rede DESFAZ — o membro volta a aparecer revogado", async () => {
    const { qc, wrapper } = novoContexto([BRUNO]);
    postSpy.mockRejectedValue(new Error("falhou"));

    const { result } = renderHook(() => useReactivateMember(), { wrapper });
    act(() => {
      result.current.mutate(BRUNO.user_id);
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(linhaDe(qc, BRUNO.user_id)?.revoked_at).toBe(BRUNO.revoked_at);
    expect(vi.mocked(showApiError)).toHaveBeenCalled();
  });
});
