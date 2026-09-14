"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface SavedLeadView {
  id: string;
  pipeline_id: string;
  label: string;
  tag: string;
  position: number;
}

export function useSavedLeadViews() {
  return useQuery({
    queryKey: ["saved-lead-views"],
    queryFn: async () => {
      const r = await apiClient.get<{ data: SavedLeadView[] }>("/api/v1/leads/saved-views");
      return r.data;
    },
    staleTime: 30_000,
  });
}
