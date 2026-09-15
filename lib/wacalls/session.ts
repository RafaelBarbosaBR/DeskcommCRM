/**
 * Leitura/gravação de `wacalls_sessions` — a sessão de pareamento (1 por
 * organização, sem `channel_session_id`: ver o cabeçalho da migration 0247
 * para o porquê de não ser um 4º `channel_sessions.provider`).
 *
 * O id da conta no servidor WaCalls é ATRIBUÍDO POR ELE em `POST
 * /api/sessions` (confirmado na fonte — não é algo que este app escolhe ou
 * prevê), então não existe um `sessionIdDaOrg()` determinístico: a primeira
 * vez que uma organização pareia, `criarSessaoNoServidor` grava o id que
 * voltou. Reparar depois de deslogar usa esse MESMO id (`client.pairSession`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WacallsAuthState } from "@/lib/wacalls/client";

export interface WacallsSessionRow {
  organizationId: string;
  wacallsSessionId: string | null;
  wacallsJid: string | null;
  wacallsPairedAt: string | null;
  status: WacallsAuthState;
  qr: string | null;
  archivedAt: string | null;
}

/** Linha ATIVA (não arquivada), ou `null` se a organização nunca pareou / desparou por último. */
export async function resolveWacallsSession(
  db: SupabaseClient,
  organizationId: string,
): Promise<WacallsSessionRow | null> {
  const { data } = await db
    .from("wacalls_sessions")
    .select("organization_id, wacalls_session_id, wacalls_jid, wacalls_paired_at, status, qr, archived_at")
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .maybeSingle();
  if (!data) return null;
  return {
    organizationId: data.organization_id,
    wacallsSessionId: data.wacalls_session_id,
    wacallsJid: data.wacalls_jid,
    wacallsPairedAt: data.wacalls_paired_at,
    status: data.status as WacallsAuthState,
    qr: data.qr,
    archivedAt: data.archived_at,
  };
}

/**
 * Grava o id que o servidor devolveu em `POST /api/sessions` — chamado uma
 * vez, no primeiro pareamento da organização. `upsert` porque pode haver uma
 * linha ARQUIVADA de um desparear anterior (a PK é `organization_id`).
 */
export async function registrarSessaoCriada(
  db: SupabaseClient,
  organizationId: string,
  wacallsSessionId: string,
): Promise<void> {
  await db.from("wacalls_sessions").upsert({
    organization_id: organizationId,
    wacalls_session_id: wacallsSessionId,
    status: "connecting",
    qr: null,
    wacalls_jid: null,
    wacalls_paired_at: null,
    archived_at: null,
  });
}

/**
 * Aplica um `auth-state`/`session-qr` do bridge de eventos. `status='open'`
 * marca `wacalls_paired_at` (a conexão mais recente que confirmou parear —
 * não é "a primeira vez de todas": o cliente Supabase não expressa
 * `coalesce` num `.update()`, e reconectar depois de uma queda também é
 * "pareado agora" de um jeito útil de mostrar na tela) e limpa o QR (não há
 * mais o que escanear); qualquer outro status preserva o QR mais recente até
 * um evento novo substituir.
 */
export async function aplicarEstadoDaSessao(
  db: SupabaseClient,
  organizationId: string,
  estado: { status: WacallsAuthState; jid?: string | null; qr?: string | null },
): Promise<void> {
  await db
    .from("wacalls_sessions")
    .update({
      status: estado.status,
      ...(estado.jid !== undefined ? { wacalls_jid: estado.jid } : {}),
      qr: estado.status === "open" ? null : (estado.qr ?? undefined),
      wacalls_paired_at: estado.status === "open" ? new Date().toISOString() : undefined,
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", organizationId)
    .is("archived_at", null);
}
