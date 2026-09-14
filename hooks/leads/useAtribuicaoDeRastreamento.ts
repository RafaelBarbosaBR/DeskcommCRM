"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { AtribuicaoDeRastreamento } from "@/lib/leads/atribuicao-de-rastreamento";

export function useAtribuicaoDeRastreamento(leadId: string | null) {
  return useQuery({
    queryKey: ["lead-atribuicao", leadId],
    enabled: !!leadId,
    queryFn: async () => {
      const r = await apiClient.get<{ data: AtribuicaoDeRastreamento }>(
        `/api/v1/leads/${leadId}/atribuicao`,
      );
      return r.data;
    },
  });
}
