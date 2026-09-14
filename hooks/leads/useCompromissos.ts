"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { StatusDeCompromisso, TipoDeCompromisso } from "@/lib/leads/compromissos/tipos";

export interface Compromisso {
  id: string;
  type: TipoDeCompromisso;
  title: string;
  notes: string | null;
  scheduled_at: string;
  status: StatusDeCompromisso;
  assigned_to: string | null;
  google_event_id: string | null;
  google_sync_error: string | null;
  created_at: string;
}

export interface NovoCompromisso {
  type: TipoDeCompromisso;
  title: string;
  notes?: string | null;
  scheduled_at: string;
  assigned_to?: string | null;
}

function queryKey(leadId: string) {
  return ["compromissos", leadId] as const;
}

export function useCompromissos(leadId: string) {
  return useQuery({
    queryKey: queryKey(leadId),
    queryFn: async () => {
      const r = await apiClient.get<{ data: Compromisso[] }>(`/api/v1/leads/${leadId}/compromissos`);
      return r.data;
    },
  });
}

export function useCreateCompromisso(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: NovoCompromisso) =>
      apiClient.post<{ data: Compromisso }>(`/api/v1/leads/${leadId}/compromissos`, input),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKey(leadId) }),
  });
}

export function useUpdateCompromisso(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; scheduled_at?: string; status?: StatusDeCompromisso }) =>
      apiClient.patch<{ data: Compromisso }>(
        `/api/v1/leads/${leadId}/compromissos/${input.id}`,
        { scheduled_at: input.scheduled_at, status: input.status },
      ),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKey(leadId) }),
  });
}

export function useDeleteCompromisso(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => apiClient.delete(`/api/v1/leads/${leadId}/compromissos/${id}`),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKey(leadId) }),
  });
}
