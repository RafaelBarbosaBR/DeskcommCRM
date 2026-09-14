import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { configuracaoDoGoogle } from "@/lib/agenda/google/config";
import { fundirTokens, precisaRenovar } from "@/lib/agenda/google/oauth";
import { renovarToken } from "@/lib/agenda/google/token";

/**
 * Sincronização com o Google Agenda pros compromissos leves do lead —
 * SEMPRE best-effort (item 7 do pedido): nunca lança, nunca bloqueia salvar
 * o compromisso no CRM. Reaproveita a conexão POR ATENDENTE que já existe
 * (`calendar_connections`, `lib/agenda/google/*` — mesmo OAuth, mesma
 * cifra), mas é UNIDIRECIONAL (CRM → Google, nunca lê de volta), então não
 * usa o reconciliador de três vias de `lib/agenda/google/sync-executor.ts`
 * — aquele resolve conflito bidirecional, problema que este recurso não tem.
 */
export type ResultadoDeSincronizacao =
  | { ok: true; eventId: string | null }
  | { ok: false; motivo: string };

const DURACAO_PADRAO_MS = 30 * 60 * 1000;
const TEMPO_LIMITE_MS = 10_000;

interface ConexaoResolvida {
  connectionId: string;
  calendarId: string;
  accessToken: string;
}

async function resolverConexao(
  admin: SupabaseClient,
  organizationId: string,
  assignedTo: string | null,
): Promise<ConexaoResolvida | { erro: string }> {
  if (!assignedTo) return { erro: "compromisso sem responsável" };

  const { data: conexao, error: erroConexao } = await admin
    .from("calendar_connections")
    .select("id, status, oauth_access_token_encrypted, oauth_refresh_token_encrypted, token_expires_at")
    .eq("organization_id", organizationId)
    .eq("user_id", assignedTo)
    .eq("provider", "google_calendar")
    .maybeSingle();
  if (erroConexao) return { erro: erroConexao.message };
  if (!conexao) return { erro: "responsável não conectou o Google Agenda" };
  if (conexao.status === "disconnected") return { erro: "conexão do Google desconectada" };
  if (!conexao.oauth_refresh_token_encrypted) return { erro: "conexão do Google sem refresh token" };

  const { data: calendario, error: erroCalendario } = await admin
    .from("calendar_connection_calendars")
    .select("external_calendar_id")
    .eq("connection_id", conexao.id)
    .order("is_destination", { ascending: false })
    .order("is_primary", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (erroCalendario) return { erro: erroCalendario.message };
  if (!calendario) return { erro: "nenhum calendário disponível na conexão do Google" };

  let accessToken = conexao.oauth_access_token_encrypted
    ? await decryptWebhookSecret(admin, conexao.oauth_access_token_encrypted)
    : null;

  if (!accessToken || precisaRenovar(conexao.token_expires_at, new Date())) {
    const refreshToken = await decryptWebhookSecret(admin, conexao.oauth_refresh_token_encrypted);
    if (!refreshToken) return { erro: "não consegui decifrar o refresh token" };

    const app = await configuracaoDoGoogle();
    if (!app) return { erro: "Google Agenda não está configurado nesta instalação" };

    const renovado = await renovarToken(app, refreshToken, { agora: new Date() });
    if (!renovado.ok) return { erro: `renovação do token falhou: ${renovado.detalhe}` };

    const fundido = fundirTokens(null, renovado.token);
    const accessCifrado = await encryptWebhookSecret(admin, fundido.access_token);
    const refreshCifrado = fundido.refresh_token
      ? await encryptWebhookSecret(admin, fundido.refresh_token)
      : conexao.oauth_refresh_token_encrypted;
    if (accessCifrado) {
      await admin
        .from("calendar_connections")
        .update({
          oauth_access_token_encrypted: accessCifrado,
          oauth_refresh_token_encrypted: refreshCifrado,
          token_expires_at: fundido.expira_em,
          updated_at: new Date().toISOString(),
        })
        .eq("id", conexao.id);
    }
    accessToken = fundido.access_token;
  }

  return {
    connectionId: conexao.id,
    calendarId: (calendario as { external_calendar_id: string }).external_calendar_id,
    accessToken,
  };
}

function montarCorpoDoEvento(input: {
  title: string;
  notes: string | null;
  scheduledAt: string;
  leadUrl: string;
}): Record<string, unknown> {
  const inicio = new Date(input.scheduledAt);
  const fim = new Date(inicio.getTime() + DURACAO_PADRAO_MS);
  const descricao = [input.notes, input.leadUrl].filter(Boolean).join("\n\n");
  return {
    summary: input.title,
    description: descricao || undefined,
    start: { dateTime: inicio.toISOString() },
    end: { dateTime: fim.toISOString() },
  };
}

async function chamarGoogle(
  metodo: "POST" | "PATCH" | "DELETE",
  url: string,
  accessToken: string,
  corpo?: Record<string, unknown>,
): Promise<{ ok: true; json: unknown } | { ok: false; status: number; detalhe: string }> {
  let resposta: Response;
  try {
    resposta = await fetch(url, {
      method: metodo,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(corpo ? { "content-type": "application/json" } : {}),
      },
      ...(corpo ? { body: JSON.stringify(corpo) } : {}),
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    });
  } catch (erro) {
    return { ok: false, status: 0, detalhe: erro instanceof Error ? erro.message : "falha de rede" };
  }

  if (resposta.status === 204) return { ok: true, json: null };

  const texto = await resposta.text().catch(() => "");
  if (!resposta.ok) {
    return { ok: false, status: resposta.status, detalhe: texto.slice(0, 300) || `status ${resposta.status}` };
  }
  try {
    return { ok: true, json: texto ? JSON.parse(texto) : null };
  } catch {
    return { ok: true, json: null };
  }
}

export async function criarEventoDeCompromisso(
  admin: SupabaseClient,
  organizationId: string,
  input: { assignedTo: string | null; title: string; notes: string | null; scheduledAt: string; leadUrl: string },
): Promise<ResultadoDeSincronizacao> {
  const conexao = await resolverConexao(admin, organizationId, input.assignedTo);
  if ("erro" in conexao) return { ok: false, motivo: conexao.erro };

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(conexao.calendarId)}/events`;
  const resultado = await chamarGoogle("POST", url, conexao.accessToken, montarCorpoDoEvento(input));
  if (!resultado.ok) {
    logger.warn("[compromissos.google] criação falhou", { detalhe: resultado.detalhe });
    return { ok: false, motivo: resultado.detalhe };
  }
  const eventId = (resultado.json as { id?: string } | null)?.id ?? null;
  return { ok: true, eventId };
}

export async function atualizarEventoDeCompromisso(
  admin: SupabaseClient,
  organizationId: string,
  googleEventId: string,
  input: { assignedTo: string | null; title: string; notes: string | null; scheduledAt: string; leadUrl: string },
): Promise<ResultadoDeSincronizacao> {
  const conexao = await resolverConexao(admin, organizationId, input.assignedTo);
  if ("erro" in conexao) return { ok: false, motivo: conexao.erro };

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(conexao.calendarId)}/events/${encodeURIComponent(googleEventId)}`;
  const resultado = await chamarGoogle("PATCH", url, conexao.accessToken, montarCorpoDoEvento(input));
  if (!resultado.ok) {
    // 404/410 = alguém apagou o evento do lado de lá — não é erro pra quem
    // está EDITANDO (diferente de excluir, onde vira sucesso): recriamos.
    if (resultado.status === 404 || resultado.status === 410) {
      return criarEventoDeCompromisso(admin, organizationId, input);
    }
    logger.warn("[compromissos.google] atualização falhou", { detalhe: resultado.detalhe });
    return { ok: false, motivo: resultado.detalhe };
  }
  const eventId = (resultado.json as { id?: string } | null)?.id ?? googleEventId;
  return { ok: true, eventId };
}

export async function removerEventoDeCompromisso(
  admin: SupabaseClient,
  organizationId: string,
  googleEventId: string,
  assignedTo: string | null,
): Promise<ResultadoDeSincronizacao> {
  const conexao = await resolverConexao(admin, organizationId, assignedTo);
  if ("erro" in conexao) return { ok: false, motivo: conexao.erro };

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(conexao.calendarId)}/events/${encodeURIComponent(googleEventId)}`;
  const resultado = await chamarGoogle("DELETE", url, conexao.accessToken);
  // 404/410 = a pessoa já apagou manualmente do lado de lá — item 7 do
  // pedido: isso é SUCESSO, não erro.
  if (!resultado.ok && resultado.status !== 404 && resultado.status !== 410) {
    logger.warn("[compromissos.google] remoção falhou", { detalhe: resultado.detalhe });
    return { ok: false, motivo: resultado.detalhe };
  }
  return { ok: true, eventId: null };
}
