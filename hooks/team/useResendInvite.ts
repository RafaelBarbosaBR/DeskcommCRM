"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

export function useResendInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (inviteId: string) =>
      apiClient.post<{
        data: { email: string; expires_at: string; email_dispatched: boolean; accept_url: string };
      }>(`/api/v1/team/invites/${inviteId}/resend`, {}),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team", "invites"] });
    },
  });
}
