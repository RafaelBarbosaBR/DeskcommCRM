"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

interface Resposta {
  data: { whatsapp_default_country_code: string };
}

/** Configurável por conta (Configurações → Organização) — nunca fixo no código. */
export function useWhatsAppCountryCode() {
  return useQuery({
    queryKey: ["settings", "whatsapp-country-code"],
    queryFn: async () => {
      const r = await apiClient.get<Resposta>("/api/v1/settings/organization");
      return r.data.whatsapp_default_country_code;
    },
    staleTime: 5 * 60 * 1000,
  });
}
