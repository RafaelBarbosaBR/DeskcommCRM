/**
 * Leitura/gravação de `voice_calls` — o histórico de chamada, e a fonte que o
 * Realtime da UI assina. Sem join com `wacalls_sessions` (a tabela não tem
 * FK para lá — ver o cabeçalho da migration 0247): tudo aqui resolve só por
 * `organization_id`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface VoiceCallRow {
  id: string;
  organizationId: string;
  contactId: string | null;
  wacallsCallId: string;
  direction: "inbound" | "outbound";
  peerPhone: string;
  status: "starting" | "ringing" | "connected" | "ended";
  endReason: string | null;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  ownerUserId: string | null;
  createdBy: string | null;
}

function paraLinha(data: Record<string, unknown>): VoiceCallRow {
  return {
    id: data.id as string,
    organizationId: data.organization_id as string,
    contactId: (data.contact_id as string | null) ?? null,
    wacallsCallId: data.wacalls_call_id as string,
    direction: data.direction as VoiceCallRow["direction"],
    peerPhone: data.peer_phone as string,
    status: data.status as VoiceCallRow["status"],
    endReason: (data.end_reason as string | null) ?? null,
    startedAt: data.started_at as string,
    answeredAt: (data.answered_at as string | null) ?? null,
    endedAt: (data.ended_at as string | null) ?? null,
    durationMs: (data.duration_ms as number | null) ?? null,
    ownerUserId: (data.owner_user_id as string | null) ?? null,
    createdBy: (data.created_by as string | null) ?? null,
  };
}

export async function resolveVoiceCall(
  db: SupabaseClient,
  organizationId: string,
  callId: string,
): Promise<VoiceCallRow | null> {
  const { data } = await db
    .from("voice_calls")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", callId)
    .maybeSingle();
  return data ? paraLinha(data) : null;
}

/**
 * Quem pode ENCERRAR uma chamada em andamento: quem está na linha
 * (`owner_user_id`) ou, se ninguém assumiu ainda (inbound tocando), qualquer
 * agent+ da organização — mesmo raciocínio de `conversations`: uma ligação
 * sem dono ainda não é propriedade de ninguém para travar os outros fora.
 */
export function podeEncerrar(call: VoiceCallRow, userId: string): boolean {
  if (call.status === "ended") return false;
  if (call.ownerUserId === null) return true;
  return call.ownerUserId === userId;
}

/**
 * `upsert` com `ignoreDuplicates`, não `insert` puro: o bridge de eventos
 * (`events-bridge.ts`) recebe o `call-status` outbound do servidor — emitido
 * DENTRO do mesmo handler HTTP que cria a chamada, antes da nossa resposta
 * voltar — e pode inserir esta MESMA linha antes desta função rodar. As duas
 * escritas concordam nos dados (mesmo `wacalls_call_id`, mesma direção); a
 * corrida decide só QUEM chega primeiro, nunca o conteúdo.
 */
export async function criarChamadaOutbound(
  db: SupabaseClient,
  input: {
    organizationId: string;
    contactId: string | null;
    wacallsCallId: string;
    peerPhone: string;
    createdBy: string;
  },
): Promise<VoiceCallRow | null> {
  await db
    .from("voice_calls")
    .upsert(
      {
        organization_id: input.organizationId,
        contact_id: input.contactId,
        wacalls_call_id: input.wacallsCallId,
        direction: "outbound",
        peer_phone: input.peerPhone,
        status: "starting",
        owner_user_id: input.createdBy,
        created_by: input.createdBy,
      },
      { onConflict: "organization_id,wacalls_call_id", ignoreDuplicates: true },
    );
  const { data } = await db
    .from("voice_calls")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("wacalls_call_id", input.wacallsCallId)
    .maybeSingle();
  return data ? paraLinha(data) : null;
}
