"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface VoiceSessionStatus {
  paired: boolean;
  status: "connecting" | "qr" | "open" | "logged_out" | null;
  qr: string | null;
  jid: string | null;
}

const QUERY_KEY = ["voice", "session"];

/**
 * Status da sessão de pareamento — lido do NOSSO banco, não do servidor
 * WaCalls (`app/api/v1/voice/sessions/route.ts` já explica por quê: o bridge
 * de eventos mantém isto em sincronia via SSE).
 *
 * Poll curto (3s) enquanto não pareou — o QR muda a cada rodada e a tela
 * precisa acompanhar; poll longo (30s) depois de pareado, só para acusar uma
 * queda de conexão eventual.
 */
export function useVoiceSessionStatus() {
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => apiClient.get<{ data: VoiceSessionStatus }>("/api/v1/voice/sessions"),
    refetchInterval: (q) => (q.state.data?.data.status === "open" ? 30_000 : 3_000),
  });
  return {
    sessao: query.data?.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

export function usePairVoiceSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => apiClient.post<{ data: { status: string } }>("/api/v1/voice/sessions/pair", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}

export function useUnpairVoiceSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => apiClient.delete<{ data: { paired: boolean } }>("/api/v1/voice/sessions"),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}
