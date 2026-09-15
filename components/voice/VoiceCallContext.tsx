"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { useAuth } from "@/hooks/auth/AuthProvider";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { createClient } from "@/lib/supabase/browser";

export interface ChamadaDeVoz {
  id: string;
  contactId: string | null;
  direction: "inbound" | "outbound";
  peerPhone: string;
  status: "starting" | "ringing" | "connected" | "ended";
  ownerUserId: string | null;
  startedAt: string;
}

interface VoiceCallCtxValue {
  /** A chamada que ESTA pessoa deveria ver na tela agora — tocando ou em andamento com ela. */
  chamadaRelevante: ChamadaDeVoz | null;
  /** Zera a chamada corrente na tela (ex.: fechar o painel depois de encerrar) sem esperar o Realtime confirmar. */
  descartarChamadaAtual: () => void;
}

const Ctx = createContext<VoiceCallCtxValue | null>(null);

function linhaParaChamada(row: Record<string, unknown>): ChamadaDeVoz {
  return {
    id: row.id as string,
    contactId: (row.contact_id as string | null) ?? null,
    direction: row.direction as ChamadaDeVoz["direction"],
    peerPhone: row.peer_phone as string,
    status: row.status as ChamadaDeVoz["status"],
    ownerUserId: (row.owner_user_id as string | null) ?? null,
    startedAt: row.started_at as string,
  };
}

/**
 * O estado global de "há uma chamada de voz acontecendo agora" — monta em
 * `app/app/layout.tsx` (shell autenticado) para o toque de uma ligação
 * entrando aparecer em QUALQUER rota de `/app/*`, não só numa tela dedicada.
 *
 * Fonte de verdade: Realtime em `voice_calls` (publicada em
 * `supabase_realtime` pela migration 0247). Sem polling — o volume de
 * chamadas por organização é baixo o bastante para o Realtime bastar, ao
 * contrário do inbox de mensagens.
 */
export function VoiceCallProvider({ children }: { children: React.ReactNode }) {
  const { user, activeOrg } = useAuth();
  const [chamadas, setChamadas] = useState<Record<string, ChamadaDeVoz>>({});
  const [descartadaId, setDescartadaId] = useState<string | null>(null);

  // Ajuste de estado durante o RENDER (não num efeito) ao trocar de
  // organização — o padrão que a própria doc do React recomenda para "estado
  // que precisa zerar quando uma prop muda": React descarta o render com o
  // estado velho antes de pintar a tela, sem o encadeamento de commits extra
  // que `setState` dentro de um `useEffect` provocaria.
  const [orgRastreada, setOrgRastreada] = useState(activeOrg?.orgId);
  if (activeOrg?.orgId !== orgRastreada) {
    setOrgRastreada(activeOrg?.orgId);
    setChamadas({});
    setDescartadaId(null);
  }

  useEffect(() => {
    if (!activeOrg) return;
    let cancelado = false;
    const supabase = createClient();
    supabase
      .from("voice_calls")
      .select("id, contact_id, direction, peer_phone, status, owner_user_id, started_at")
      .eq("organization_id", activeOrg.orgId)
      .in("status", ["starting", "ringing", "connected"])
      .then(({ data }: { data: Record<string, unknown>[] | null }) => {
        if (cancelado || !data) return;
        setChamadas(Object.fromEntries(data.map((r) => [r.id as string, linhaParaChamada(r)])));
      });
    return () => {
      cancelado = true;
    };
    // Só re-busca quando a ORGANIZAÇÃO muda de verdade — `activeOrg` inteiro
    // entraria em loop com qualquer campo dele que mude de identidade
    // (`visibility_mode` etc.), sem relação com esta busca.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrg?.orgId]);

  const handleChange = useCallback((payload: unknown) => {
    const p = payload as { eventType?: string; new?: Record<string, unknown>; old?: Record<string, unknown> };
    if (!p.eventType) return; // entrega sintética de reassinatura ({tipo:"reassinado"}) — o efeito de busca inicial já resolveu isso
    if (p.eventType === "DELETE") {
      const id = p.old?.id as string | undefined;
      if (id) setChamadas((atual) => { const { [id]: _descartada, ...resto } = atual; return resto; });
      return;
    }
    const linha = linhaParaChamada(p.new ?? {});
    setChamadas((atual) => {
      if (linha.status === "ended") {
        const { [linha.id]: _descartada, ...resto } = atual;
        return resto;
      }
      return { ...atual, [linha.id]: linha };
    });
  }, []);

  useRealtimeChannel({
    name: `voice-calls:${activeOrg?.orgId ?? "none"}`,
    postgresChanges: {
      event: "*",
      table: "voice_calls",
      filter: activeOrg ? `organization_id=eq.${activeOrg.orgId}` : undefined,
    },
    onChange: handleChange,
    enabled: Boolean(activeOrg),
  });

  const chamadaRelevante = useMemo(() => {
    const lista = Object.values(chamadas).filter((c) => c.id !== descartadaId);
    // Prioridade: a que estou atendendo AGORA > tocando sem dono (qualquer
    // agent+ pode assumir) > tocando que EU assumi mas ainda não conectou.
    return (
      lista.find((c) => c.status === "connected" && c.ownerUserId === user.id) ??
      lista.find((c) => c.status === "ringing" && c.ownerUserId === null) ??
      lista.find((c) => c.status === "ringing" && c.ownerUserId === user.id) ??
      null
    );
  }, [chamadas, descartadaId, user.id]);

  const value = useMemo<VoiceCallCtxValue>(
    () => ({
      chamadaRelevante,
      descartarChamadaAtual: () => setDescartadaId(chamadaRelevante?.id ?? null),
    }),
    [chamadaRelevante],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useVoiceCall(): VoiceCallCtxValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useVoiceCall must be used inside <VoiceCallProvider>");
  return ctx;
}
