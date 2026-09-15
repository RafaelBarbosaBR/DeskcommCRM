/**
 * A PONTE entre o servidor WaCalls (fora do processo, um único serviço por
 * instalação — não por organização) e o banco. Roda como um SEGUNDO loop de
 * fundo no worker (`workers/agent-worker/main.ts`), ao lado do loop principal
 * do agent-engine — só existe se `getWacallsClient()` não for `null`.
 *
 * CONSOME O STREAM SSE (`GET /api/events`) — confirmado na fonte do
 * servidor (`cmd/server/broker.go`) e testado rodando a imagem de verdade
 * nesta máquina. NÃO é polling: a conexão fica aberta o tempo todo (o
 * servidor manda `: ping` a cada 20s), e reconecta com backoff quando cai.
 * O stream é GLOBAL (todas as contas pareadas neste servidor, não por
 * organização) — cada evento carrega `sessionId`, e é isso que resolve para
 * qual organização ele pertence.
 *
 * NÃO mexe em `conversations.bot_silenced_until`. Cogitado e descartado: essa
 * coluna é o mecanismo de handoff (`lib/agent-engine/agent/human-handoff.ts`,
 * "só o humano libera via CRM") — automatizar o silêncio E o des-silêncio ao
 * redor de uma chamada tocaria essa invariante de segurança por um caminho
 * que não é o humano. Fica fora do escopo desta entrega; quem quiser
 * silenciar durante a chamada usa o handoff manual já existente.
 */
import type pg from "pg";
import type { Logger } from "../agent-engine/obs/logger";
import { escolherContatoCanonico } from "@/lib/channels/contato-por-telefone";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import { getWacallsClient } from "./client";

export interface VoiceCallsBridgeConfig {
  /** Teto do backoff exponencial de reconexão após queda do stream. */
  maxBackoffMs?: number;
}

async function resolveContatoPorTelefone(
  pool: pg.Pool,
  organizationId: string,
  rawPhone: string,
): Promise<string | null> {
  const variantes = phoneLookupVariants(rawPhone);
  if (variantes.length === 0) return null;
  const { rows } = await pool.query<{ id: string; phone_number: string | null }>(
    `select id, phone_number from public.contacts
      where organization_id = $1 and phone_number = any($2) and is_merged_into is null
      limit 4`,
    [organizationId, variantes],
  );
  return escolherContatoCanonico(rows, rawPhone)?.id ?? null;
}

async function sessaoDaOrg(pool: pg.Pool, wacallsSessionId: string): Promise<string | null> {
  const { rows } = await pool.query<{ organization_id: string }>(
    `select organization_id from public.wacalls_sessions where wacalls_session_id = $1 and archived_at is null`,
    [wacallsSessionId],
  );
  return rows[0]?.organization_id ?? null;
}

/** Formato compartilhado por `auth-state`/`session-qr`/`session-list` — os três carregam pareamento. */
/** Lê um campo string de um evento cru, ou `null` se ausente/de outro tipo. */
function campoTexto(evento: Record<string, unknown>, chave: string): string | null {
  const v = evento[chave];
  return typeof v === "string" ? v : null;
}

/** Lê um campo number de um evento cru, ou `null` se ausente/de outro tipo. */
function campoNumero(evento: Record<string, unknown>, chave: string): number | null {
  const v = evento[chave];
  return typeof v === "number" ? v : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `owner` no evento é o `X-Client-Id` que NÓS mandamos (sempre `user.id`,
 * um uuid — ver `client.ts`/as rotas de chamada), mas o servidor WaCalls só
 * ecoa a string de volta sem validar formato nenhum. `owner_user_id` é
 * coluna `uuid`; um valor que não bate o formato vira `null` em vez de
 * estourar a query com `invalid input syntax for type uuid`.
 */
function ownerComoUuid(owner: string | null): string | null {
  return owner && UUID_RE.test(owner) ? owner : null;
}

/**
 * Um evento do stream do servidor WaCalls, aplicado ao banco. Nunca lança —
 * erro vira log e o próximo evento segue (a conexão não deve cair por causa
 * de um evento ruim isolado).
 */
export async function despacharEventoWacalls(pool: pg.Pool, evento: Record<string, unknown>, log: Logger): Promise<void> {
  const type = campoTexto(evento, "type") ?? "";

  try {
    switch (type) {
      // `session-list` é a fotografia de TODAS as contas — recebida ao
      // conectar (snapshot) e a cada mudança. Cada uma é tratada como um
      // `auth-state` isolado; contas que não são de organização nenhuma
      // nossa (sessaoDaOrg devolve null) são ignoradas em silêncio, sem log
      // — é o esperado sempre que o servidor tem sessão de outra instalação
      // apontando para ele por engano, e logar a cada snapshot encheria o
      // log à toa.
      case "session-list": {
        const sessions = Array.isArray(evento.sessions) ? (evento.sessions as Array<Record<string, unknown>>) : [];
        for (const s of sessions) {
          const sid = campoTexto(s, "id");
          const state = campoTexto(s, "state");
          if (!sid || !state) continue;
          await aplicarAuthState(pool, sid, state, campoTexto(s, "jid"), null);
        }
        break;
      }

      case "auth-state":
      case "session-qr": {
        const sid = campoTexto(evento, "sessionId");
        const state = campoTexto(evento, "state");
        const qr = campoTexto(evento, "qr");
        if (!sid) return;
        // `session-qr` não carrega `state` — o QR por si só implica "qr".
        await aplicarAuthState(pool, sid, state ?? "qr", null, qr);
        break;
      }

      case "call-status": {
        const sid = campoTexto(evento, "sessionId");
        const callId = campoTexto(evento, "id");
        const status = campoTexto(evento, "status");
        const peer = campoTexto(evento, "peer");
        const owner = ownerComoUuid(campoTexto(evento, "owner"));
        if (!sid || !callId || !status) return;
        const organizationId = await sessaoDaOrg(pool, sid);
        if (!organizationId) return;

        const contactId = peer ? await resolveContatoPorTelefone(pool, organizationId, peer) : null;
        // O evento NÃO carrega direção (confirmado lendo `broker.go`:
        // `upsertCall` manda `owner`/`status`/`peer`/`startedAt`, nunca
        // `direction`). O sinal indireto é `owner`: uma ligação OUTBOUND já
        // nasce com dono (`doStartCall` grava `Owner` no mesmo instante que
        // cria o registro — antes até da nossa própria rota conseguir
        // inserir a linha aqui, por isso este insert quase sempre chega
        // primeiro para chamadas que NÓS discamos); uma INBOUND só ganha
        // dono depois de alguém aceitar. `on conflict` nunca sobrescreve
        // `direction` — só a primeira inserção decide, e a proteção real
        // contra o caso raro de já existir linha certa é o próprio filtro
        // `where status <> 'ended'` abaixo.
        await pool.query(
          `insert into public.voice_calls (organization_id, contact_id, wacalls_call_id, direction, peer_phone, status, owner_user_id)
           values ($1, $2, $3, case when $6::uuid is not null then 'outbound' else 'inbound' end, $4, $5, $6::uuid)
           on conflict (organization_id, wacalls_call_id) do update
             set status = excluded.status,
                 answered_at = case when excluded.status = 'connected' and public.voice_calls.answered_at is null
                                    then now() else public.voice_calls.answered_at end,
                 owner_user_id = coalesce(public.voice_calls.owner_user_id, excluded.owner_user_id),
                 updated_at = now()
             where public.voice_calls.status <> 'ended'`,
          [organizationId, contactId, callId, peer ?? "", status, owner],
        );
        break;
      }

      case "incoming": {
        // O primeiro sinal de uma chamada ENTRANDO — chega ANTES do
        // `call-status` correspondente (emitido por `cm.OnIncoming` no
        // servidor, separado do `upsertCall`). Cria a linha como 'ringing',
        // inbound, sem dono — o `call-status` que vier atrás só reforça.
        const sid = campoTexto(evento, "sessionId");
        const callId = campoTexto(evento, "id");
        const peer = campoTexto(evento, "peer");
        if (!sid || !callId || !peer) return;
        const organizationId = await sessaoDaOrg(pool, sid);
        if (!organizationId) return;
        const contactId = await resolveContatoPorTelefone(pool, organizationId, peer);
        await pool.query(
          `insert into public.voice_calls (organization_id, contact_id, wacalls_call_id, direction, peer_phone, status)
           values ($1, $2, $3, 'inbound', $4, 'ringing')
           on conflict (organization_id, wacalls_call_id) do nothing`,
          [organizationId, contactId, callId, peer],
        );
        break;
      }

      case "call-ended": {
        const sid = campoTexto(evento, "sessionId");
        const callId = campoTexto(evento, "id");
        const reason = campoTexto(evento, "reason");
        const endedAtMs = campoNumero(evento, "endedAt");
        if (!sid || !callId) return;
        const organizationId = await sessaoDaOrg(pool, sid);
        if (!organizationId) return;

        // `status <> 'ended'` faz o UPDATE só afetar (e só devolver linha) na
        // transição REAL — reprocessar o mesmo evento após uma queda de
        // conexão não duplica o aviso de chamada perdida abaixo. Mesmo
        // raciocínio do `fn_followup_patch` (0246): checar a transição, não
        // o estado final.
        const { rows } = await pool.query<{
          id: string;
          contact_id: string | null;
          direction: string;
          answered_at: string | null;
        }>(
          `update public.voice_calls
              set status = 'ended', end_reason = $2,
                  ended_at = coalesce(to_timestamp($3::double precision / 1000.0), now()),
                  duration_ms = case when answered_at is not null
                                     then extract(epoch from (now() - answered_at)) * 1000
                                     else duration_ms end,
                  updated_at = now()
            where organization_id = $1 and wacalls_call_id = $4 and status <> 'ended'
            returning id, contact_id, direction, answered_at`,
          [organizationId, reason, endedAtMs, callId],
        );
        const linha = rows[0];
        if (!linha) return;

        // Perdida = inbound e ninguém atendeu (nunca chegou a 'connected').
        if (linha.direction === "inbound" && linha.answered_at === null) {
          await pool.query(
            `insert into public.agent_inbox_items
               (organization_id, kind, severity, title, body, ref_kind, ref_id)
             select $1, 'voice_call_missed', 'warn',
               'Uma chamada de voz tocou e ninguém atendeu',
               'O telefone tocou e ninguém atendeu. Confira se vale retornar a chamada.',
               case when $2::uuid is not null then 'contact' else null end, $2`,
            [organizationId, linha.contact_id],
          );
        }
        break;
      }

      case "call-list":
      case "incoming-claimed":
        // `call-list` é redundante com `call-status` (mesmo dado, agregado);
        // `incoming-claimed` só informa QUEM assumiu, e isso já é gravado
        // pela própria rota de aceitar (`app/api/v1/voice/calls/[id]/accept`)
        // no instante em que ela chama a API — nada a fazer aqui.
        break;

      default:
        log.warn("[voice-bridge] tipo de evento desconhecido — ignorado", { type });
    }
  } catch (err) {
    log.error("[voice-bridge] falha ao aplicar evento — seguindo para o próximo", {
      type,
      erro: err instanceof Error ? err.message : "unknown",
    });
  }
}

async function aplicarAuthState(
  pool: pg.Pool,
  wacallsSessionId: string,
  state: string,
  jid: string | null,
  qr: string | null,
): Promise<void> {
  const organizationId = await sessaoDaOrg(pool, wacallsSessionId);
  if (!organizationId) return; // conta de outra instalação apontando para o mesmo servidor — ignora.
  await pool.query(
    `update public.wacalls_sessions
        set status = $2,
            wacalls_jid = coalesce($3, wacalls_jid),
            qr = case when $2 = 'open' then null else coalesce($4, qr) end,
            wacalls_paired_at = case when $2 = 'open' then now() else wacalls_paired_at end,
            updated_at = now()
      where organization_id = $1`,
    [organizationId, state, jid, qr],
  );
}

/**
 * Loop de fundo: só existe quando `WACALLS_API_BASE_URL` está configurada —
 * mesmo padrão condicional de `sessionWatchdogLoop` (liga só com a
 * dependência presente, nunca abre conexão à toa numa instalação sem o
 * serviço). Mantém UMA conexão SSE aberta, reconectando com backoff quando
 * cai — não é um "tick" periódico como os outros loops do worker.
 */
export async function runVoiceCallsBridgeLoop(
  pool: pg.Pool,
  cfg: VoiceCallsBridgeConfig,
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  const client = getWacallsClient();
  if (!client) {
    log.warn("[voice-bridge] WACALLS_API_BASE_URL ausente — loop desligado", {});
    return;
  }

  const maxBackoffMs = cfg.maxBackoffMs ?? 30_000;
  let backoffMs = 1_000;

  const dormir = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });

  while (!signal.aborted) {
    try {
      for await (const evento of client.streamEvents(signal)) {
        await despacharEventoWacalls(pool, evento, log);
        backoffMs = 1_000; // stream vivo e entregando — reseta o backoff a cada evento recebido.
      }
      // O generator terminou sem erro: o servidor fechou a conexão de
      // propósito (deploy, restart) — reconecta com o backoff mínimo, não é
      // uma falha.
      if (!signal.aborted) await dormir(1_000);
    } catch (err) {
      if (signal.aborted) return;
      log.warn("[voice-bridge] stream de eventos caiu — reconectando", {
        erro: err instanceof Error ? err.message : "unknown",
        backoffMs,
      });
      await dormir(backoffMs);
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    }
  }
}
