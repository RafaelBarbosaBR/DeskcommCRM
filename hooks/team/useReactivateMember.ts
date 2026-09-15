"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { TeamMember } from "@/hooks/team/useTeamMembers";

const MEMBERS_KEY = ["team", "members"] as const;

/**
 * O inverso de `useRevokeMember`. Espelho dele, de propósito — inclusive no
 * otimismo (G2-02): a linha volta a ativa no clique, sem esperar a rede.
 */
export function useReactivateMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) =>
      apiClient.post<{
        data: { user_id: string; reactivated_at?: string; already_active?: boolean };
      }>(`/api/v1/team/${userId}/reactivate`, {}),
    onMutate: async (userId) => {
      await qc.cancelQueries({ queryKey: MEMBERS_KEY });
      const previous = qc.getQueryData<{ data: TeamMember[] }>(MEMBERS_KEY);
      qc.setQueryData<{ data: TeamMember[] }>(MEMBERS_KEY, (old) =>
        old
          ? {
              ...old,
              data: old.data.map((m) => (m.user_id === userId ? { ...m, revoked_at: null } : m)),
            }
          : old,
      );
      return { previous };
    },
    onError: (err, _userId, context) => {
      if (context?.previous) qc.setQueryData(MEMBERS_KEY, context.previous);
      showApiError(err);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
    },
  });
}
