"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface TeamInvite {
  id: string;
  email: string;
  role: string;
  status: "pending" | "accepted" | "expired" | "revoked";
  invited_by: string | null;
  invited_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  resent_count: number;
  last_resent_at: string | null;
  email_dispatched: boolean;
  /** `null` quando o convite não está mais vivo — nada para copiar. */
  accept_url: string | null;
}

export function useTeamInvites(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["team", "invites"],
    queryFn: async () => apiClient.get<{ data: TeamInvite[] }>("/api/v1/team/invites"),
    staleTime: 15_000,
    enabled: opts?.enabled ?? true,
  });
}
