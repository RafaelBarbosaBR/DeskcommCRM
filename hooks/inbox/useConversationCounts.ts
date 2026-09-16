"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface ConversationCounts {
  /**
   * OPCIONAIS de propósito: um cache de react-query gravado antes deste deploy
   * não tem estes campos, e a tela lê o cache antes da primeira resposta nova.
   * Marcá-los obrigatórios daria `undefined` onde o tipo promete `number` — e o
   * badge imprimiria "NaN" no primeiro segundo depois de atualizar.
   */
  fila?: number;
  automatico?: number;
  /** Nome antigo de `fila`, mantido pela rota versionada. Prefira `fila`. */
  unassigned: number;
  mine: number;
  all: number;
  /** Ausente em cache gravado antes deste campo existir — mesma razão do `?` acima. */
  closed?: number;
}

export interface ConversationCountsFilters {
  channel_session_id?: string;
  tag?: string;
  onlyUnread?: boolean;
}

/**
 * Contagens por visão do inbox (G4-02). O endpoint usa o client RLS-scoped —
 * um agent em modo own* recebe a contagem do seu escopo, não o total da org.
 *
 * Os mesmos três filtros que a listagem aplica (`tag`, `channel_session_id`,
 * `onlyUnread`) entram na query E na chave do cache: sem os dois, trocar de
 * canal/tag mostraria o badge da seleção ANTERIOR até o refetch de 30s.
 */
export function useConversationCounts(
  orgId: string | null,
  filters: ConversationCountsFilters = {},
) {
  const { channel_session_id, tag, onlyUnread } = filters;
  return useQuery({
    queryKey: ["conversation-counts", orgId, channel_session_id, tag, onlyUnread],
    enabled: !!orgId,
    refetchInterval: 30_000,
    queryFn: () => {
      const qs = new URLSearchParams();
      if (channel_session_id) qs.set("channel_session_id", channel_session_id);
      if (tag) qs.set("tag", tag);
      if (onlyUnread) qs.set("only_unread", "true");
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return apiClient
        .get<{ data: ConversationCounts }>(`/api/v1/conversations/counts${suffix}`)
        .then((r) => r.data);
    },
  });
}
