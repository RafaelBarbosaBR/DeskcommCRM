"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

export function useAddNote(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: string) =>
      apiClient.post<{ data: { saved: true } }>(`/api/v1/leads/${leadId}/notes`, { body }),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["timeline", leadId] });
    },
  });
}
