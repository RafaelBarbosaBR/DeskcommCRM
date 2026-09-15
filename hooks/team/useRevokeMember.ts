"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { TeamMember } from "@/hooks/team/useTeamMembers";

const MEMBERS_KEY = ["team", "members"] as const;

/**
 * Otimista, no mesmo molde de `useChangeRole` (G2-02): a linha muda no
 * clique, sem esperar a volta da rede — o `invalidateQueries` no `onSuccess`
 * já refazia o fetch sozinho, mas só DEPOIS da resposta chegar. O que faltava
 * era o intervalo entre o clique e ela: quem clicava via a linha parada até
 * a rede responder, como se nada tivesse acontecido.
 */
export function useRevokeMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) =>
      apiClient.post<{ data: { user_id: string; revoked_at?: string; already_revoked?: boolean } }>(
        `/api/v1/team/${userId}/revoke`,
        {},
      ),
    onMutate: async (userId) => {
      await qc.cancelQueries({ queryKey: MEMBERS_KEY });
      const previous = qc.getQueryData<{ data: TeamMember[] }>(MEMBERS_KEY);
      qc.setQueryData<{ data: TeamMember[] }>(MEMBERS_KEY, (old) =>
        old
          ? {
              ...old,
              data: old.data.map((m) =>
                m.user_id === userId ? { ...m, revoked_at: new Date().toISOString() } : m,
              ),
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
