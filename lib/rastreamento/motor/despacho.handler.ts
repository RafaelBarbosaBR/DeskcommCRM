import type { SupabaseClient } from "@supabase/supabase-js";

import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";
import { lerCredencialMeta } from "@/lib/plataformas-de-anuncio/meta/credenciais-rastreamento";
import { transporteMetaRastreamento } from "@/lib/plataformas-de-anuncio/meta/rastreamento";
import { lerCredencialGa4 } from "@/lib/plataformas-de-anuncio/ga4/credenciais";
import { transporteGa4 } from "@/lib/plataformas-de-anuncio/ga4/measurement-protocol";
import { lerCredencialGoogleAds } from "@/lib/plataformas-de-anuncio/google-ads/credenciais";
import { transporteGoogleAds } from "@/lib/plataformas-de-anuncio/google-ads/click-conversion-upload";
import type { ConversaoOffline, NomeDoEvento, ResultadoDeEnvio } from "@/lib/plataformas-de-anuncio/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { sanitizarParaAuditoria } from "./sanitizar-log";
import type { TipoDeEventoInterno } from "./types";

const CONSUMER_KEY = "rastreamento.despacho";

export type Provider = "META" | "GA4" | "GOOGLE_ADS";

/**
 * 1min, 5min, 30min, 2h, 12h — os 5 passos de backoff do item 1 do pedido
 * ("ex.: 1min, 5min, 30min, 2h, 12h"). `MAX_TENTATIVAS` é a 1ª tentativa +
 * os 5 retries destes passos: a 6ª tentativa, se falhar, esgota — vira
 * `dead_letter`, nunca um 6º agendamento.
 */
export const BACKOFF_MINUTOS = [1, 5, 30, 120, 720] as const;
export const MAX_TENTATIVAS = BACKOFF_MINUTOS.length + 1;

/** `tentativaFeita` é 1-based (a tentativa que ACABOU de rodar). */
export function backoffAt(tentativaFeita: number): string {
  const indice = Math.min(Math.max(tentativaFeita - 1, 0), BACKOFF_MINUTOS.length - 1);
  const minutos = BACKOFF_MINUTOS[indice]!;
  return new Date(Date.now() + minutos * 60_000).toISOString();
}

/**
 * O roteamento cliente×servidor por evento×provider (decisão 5 do plano).
 * Só entram aqui as combinações que o SERVIDOR precisa despachar —
 * GA4 PAGE_VIEW/CONTACT e Google Ads PAGE_VIEW/CONTACT são só client-side
 * (gtag, disparado direto pelo tracker.js) e nunca geram linha em
 * `outbound_events`, de propósito: gerar a linha e nunca despachá-la seria
 * "restrição não registrada" pro lado errado — pareceria pendência.
 */
const ROTEAMENTO: Record<TipoDeEventoInterno, readonly Provider[]> = {
  PAGE_VIEW: ["META"],
  CONTACT: ["META"],
  LEAD: ["META", "GA4", "GOOGLE_ADS"],
  QUALIFIED: ["META", "GA4", "GOOGLE_ADS"],
  PURCHASE: ["META", "GA4", "GOOGLE_ADS"],
};

const NOME_DO_EVENTO: Record<TipoDeEventoInterno, NomeDoEvento> = {
  PAGE_VIEW: "PageView",
  CONTACT: "Contact",
  LEAD: "Lead",
  QUALIFIED: "Qualified",
  PURCHASE: "Purchase",
};

export interface InternalEventRow {
  id: string;
  organization_id: string;
  event_type: TipoDeEventoInterno;
  visitor_id: string | null;
  contact_id: string | null;
  lead_id: string | null;
  touchpoint_id: string | null;
  value_cents: number | null;
  currency: string | null;
  occurred_at: string;
  payload: Record<string, unknown>;
}

/** As colunas de `internal_events` que `tentarEnviarParaProvider` precisa —
 * exportada pra `handle()` e pelo cron de retry lerem exatamente as mesmas,
 * nunca duas listas que podem divergir. */
export const COLUNAS_DO_EVENTO_INTERNO =
  "id, organization_id, event_type, visitor_id, contact_id, lead_id, touchpoint_id, value_cents, currency, occurred_at, payload";

interface AtribuicaoResolvida {
  clientId: string | null;
  email: string | null;
  telefone: string | null;
  fbclid: string | null;
  fbc: string | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
}

async function resolverAtribuicao(
  admin: SupabaseClient,
  evento: InternalEventRow,
): Promise<AtribuicaoResolvida> {
  let clientId: string | null = null;
  if (evento.visitor_id) {
    const { data } = await admin
      .from("visitors")
      .select("visitor_id")
      .eq("id", evento.visitor_id)
      .maybeSingle();
    clientId = (data as { visitor_id: string } | null)?.visitor_id ?? null;
  }

  let email: string | null = null;
  let telefone: string | null = null;
  if (evento.contact_id) {
    const { data } = await admin
      .from("contacts")
      .select("email, phone_number")
      .eq("id", evento.contact_id)
      .maybeSingle();
    const contato = data as { email: string | null; phone_number: string | null } | null;
    email = contato?.email ?? null;
    telefone = contato?.phone_number ? contato.phone_number.replace(/\D/g, "") : null;
  }

  // Click-ids: preferência pelo touchpoint específico deste evento; na
  // ausência, o snapshot que `pipeline.handler.ts` já gravou em `payload`
  // (mesmos nomes de campo). Nunca inventado — os dois caminhos só repassam
  // o que já foi capturado antes.
  let fbclid: string | null = null;
  let fbc: string | null = null;
  let gclid: string | null = null;
  let gbraid: string | null = null;
  let wbraid: string | null = null;

  if (evento.touchpoint_id) {
    const { data } = await admin
      .from("touchpoints")
      .select("fbclid, fbc, gclid, gbraid, wbraid")
      .eq("id", evento.touchpoint_id)
      .maybeSingle();
    const tp = data as {
      fbclid: string | null;
      fbc: string | null;
      gclid: string | null;
      gbraid: string | null;
      wbraid: string | null;
    } | null;
    fbclid = tp?.fbclid ?? null;
    fbc = tp?.fbc ?? null;
    gclid = tp?.gclid ?? null;
    gbraid = tp?.gbraid ?? null;
    wbraid = tp?.wbraid ?? null;
  } else {
    const p = evento.payload ?? {};
    fbclid = typeof p.fbclid === "string" ? p.fbclid : null;
    fbc = typeof p.fbc === "string" ? p.fbc : null;
    gclid = typeof p.gclid === "string" ? p.gclid : null;
    gbraid = typeof p.gbraid === "string" ? p.gbraid : null;
    wbraid = typeof p.wbraid === "string" ? p.wbraid : null;
  }

  return { clientId, email, telefone, fbclid, fbc, gclid, gbraid, wbraid };
}

function montarConversao(evento: InternalEventRow, atribuicao: AtribuicaoResolvida): ConversaoOffline {
  return {
    organizationId: evento.organization_id,
    leadId: evento.lead_id ?? evento.id,
    evento: NOME_DO_EVENTO[evento.event_type],
    eventoId: evento.id,
    ocorridoEm: new Date(evento.occurred_at),
    cliqueDeOrigem: atribuicao.fbclid ?? atribuicao.gclid ?? null,
    telefone: atribuicao.telefone,
    email: atribuicao.email,
    valorCentavos: evento.value_cents,
    moeda: evento.currency,
    clientId: atribuicao.clientId,
    gclid: atribuicao.gclid,
    gbraid: atribuicao.gbraid,
    wbraid: atribuicao.wbraid,
    fbc: atribuicao.fbc,
    actionSource: "website",
  };
}

type StatusDeDespacho = "pending" | "processing" | "sent" | "failed" | "dead_letter";

interface OutboundRow {
  id: string;
  status: StatusDeDespacho;
}

async function garantirLinhaDeDespacho(
  admin: SupabaseClient,
  evento: InternalEventRow,
  provider: Provider,
): Promise<OutboundRow> {
  const { data: existente } = await admin
    .from("outbound_events")
    .select("id, status")
    .eq("internal_event_id", evento.id)
    .eq("provider", provider)
    .maybeSingle();
  if (existente) return existente as OutboundRow;

  const { data: criado } = await admin
    .from("outbound_events")
    .insert({
      organization_id: evento.organization_id,
      internal_event_id: evento.id,
      provider,
      event_name: NOME_DO_EVENTO[evento.event_type],
      status: "pending",
    })
    .select("id, status")
    .maybeSingle();
  // Corrida com outro drain concorrente: alguém inseriu entre o select e o
  // insert acima. Relê — a linha existe, é só pegar o vencedor.
  if (!criado) {
    const { data: relido } = await admin
      .from("outbound_events")
      .select("id, status")
      .eq("internal_event_id", evento.id)
      .eq("provider", provider)
      .maybeSingle();
    return (relido as OutboundRow) ?? { id: "", status: "pending" };
  }
  return criado as OutboundRow;
}

async function resolverResultadoParaProvider(
  admin: SupabaseClient,
  organizationId: string,
  provider: Provider,
  conversao: ConversaoOffline,
): Promise<{ resultado: ResultadoDeEnvio; motivoSemCredencial: string | null }> {
  if (provider === "META") {
    const credencial = await lerCredencialMeta(admin, organizationId);
    if (!credencial.ok) return { resultado: { tipo: "permanente", detalhe: credencial.motivo }, motivoSemCredencial: credencial.motivo };
    const resultado = await transporteMetaRastreamento.enviar(credencial.credencial, conversao);
    return { resultado, motivoSemCredencial: null };
  }
  if (provider === "GA4") {
    const credencial = await lerCredencialGa4(admin, organizationId);
    if (!credencial.ok) return { resultado: { tipo: "permanente", detalhe: credencial.motivo }, motivoSemCredencial: credencial.motivo };
    const resultado = await transporteGa4.enviar(credencial.credencial, conversao);
    return { resultado, motivoSemCredencial: null };
  }
  const credencial = await lerCredencialGoogleAds(admin, organizationId);
  if (!credencial.ok) return { resultado: { tipo: "permanente", detalhe: credencial.motivo }, motivoSemCredencial: credencial.motivo };
  const resultado = await transporteGoogleAds.enviar(credencial.credencial, conversao);
  return { resultado, motivoSemCredencial: null };
}

export type DesfechoDaTentativa = "sent" | "pending" | "dead_letter" | "not_claimed";

/**
 * UMA tentativa de envio de UMA linha de `outbound_events` — o núcleo
 * reaproveitado pelos DOIS chamadores que existem hoje: `handle()` abaixo
 * (a 1ª tentativa, disparada pelo despacho imediato ou, na falta dele, pelo
 * cron de `event_log`) e `app/api/v1/cron/rastreamento-outbound-retry/
 * route.ts` (as tentativas seguintes, na hora agendada em `next_retry_at`).
 * Duplicar este corpo nos dois lugares seria o convite certo pro backoff, o
 * vocabulário de status e o sanitizador divergirem — a MESMA classe de
 * defeito que a doutrina deste repo já pagou em outros módulos.
 *
 * Claim otimista PRÓPRIO (pending→processing), nem que o chamador já tenha
 * filtrado por status: uma linha pode ter sido reclamada por outra
 * instância entre o SELECT do chamador e esta chamada — `not_claimed` é o
 * sinal de "não é mais sua vez", não um erro.
 */
export async function tentarEnviarParaProvider(
  admin: SupabaseClient,
  evento: InternalEventRow,
  provider: Provider,
  outboundEventId: string,
): Promise<DesfechoDaTentativa> {
  const inicio = new Date().toISOString();
  const { data: claimados } = await admin
    .from("outbound_events")
    .update({ status: "processing", last_attempt_at: inicio })
    .eq("id", outboundEventId)
    .eq("status", "pending")
    .select("id, attempt_count");
  if (!claimados?.length) return "not_claimed";

  const tentativaFeita = ((claimados[0] as { attempt_count: number }).attempt_count ?? 0) + 1;

  const atribuicao = await resolverAtribuicao(admin, evento);
  const conversao = montarConversao(evento, atribuicao);
  const { resultado } = await resolverResultadoParaProvider(
    admin,
    evento.organization_id,
    provider,
    conversao,
  );

  const agora = new Date().toISOString();
  const deuCerto = resultado.tipo === "ok";
  // SANITIZADO antes de tocar o banco — nunca o `detalhe` cru. Ver o
  // cabeçalho de `sanitizar-log.ts`: é a ÚLTIMA porta, não a única.
  const erroSanitizado = deuCerto ? null : sanitizarParaAuditoria(resultado.detalhe);

  // O log BRUTO da tentativa entra SEMPRE — sucesso ou falha. É o que a
  // seção (c) da auditoria mostra: "o que aconteceu de verdade a cada
  // chamada", não só o desfecho final da linha em outbound_events.
  await admin.from("platform_event_logs").insert({
    organization_id: evento.organization_id,
    outbound_event_id: outboundEventId,
    internal_event_id: evento.id,
    provider,
    event_name: NOME_DO_EVENTO[evento.event_type],
    status: deuCerto ? "ok" : "erro",
    error_message: erroSanitizado,
    attempted_at: agora,
  });

  let desfecho: DesfechoDaTentativa;
  if (deuCerto) {
    await admin
      .from("outbound_events")
      .update({
        status: "sent",
        attempt_count: tentativaFeita,
        sent_at: agora,
        resolved_at: agora,
        error_message: null,
        next_retry_at: null,
        detail: resultado.detalhe ?? null,
      })
      .eq("id", outboundEventId);
    desfecho = "sent";
  } else {
    // Esgotamento é UNIFICADO pros dois tipos de falha (item 1 do pedido:
    // "todo envio que falhar — rede, credencial, erro da API — entra na
    // fila de retry com backoff"). Não faria sentido reagendar uma
    // credencial ausente pra sempre, mas também não é este código quem
    // decide isso sozinho: se o operador cadastrar a credencial a tempo, a
    // próxima tentativa agendada simplesmente funciona — é o comportamento
    // que o pedido descreve, sem um segundo caminho "permanente = nunca
    // retry" que o pedido não pediu.
    const esgotado = tentativaFeita >= MAX_TENTATIVAS;
    await admin
      .from("outbound_events")
      .update({
        status: esgotado ? "dead_letter" : "pending",
        attempt_count: tentativaFeita,
        error_message: erroSanitizado,
        next_retry_at: esgotado ? null : backoffAt(tentativaFeita),
        resolved_at: esgotado ? agora : null,
        reason: resultado.tipo === "permanente" ? "config_ou_recusa" : "falha_transitoria",
        detail: resultado.detalhe,
      })
      .eq("id", outboundEventId);
    desfecho = esgotado ? "dead_letter" : "pending";
  }

  if (provider === "META") {
    await admin.from("meta_event_logs").upsert(
      {
        organization_id: evento.organization_id,
        internal_event_id: evento.id,
        event_id: evento.id,
        capi_status: resultado.tipo,
        capi_response: { detalhe: deuCerto ? null : erroSanitizado },
      },
      { onConflict: "internal_event_id" },
    );
  }

  return desfecho;
}

/**
 * Fan-out do evento interno pros providers habilitados — a 1ª TENTATIVA de
 * cada um. Relê tudo do banco (nunca confia no payload do event_log).
 *
 * Sempre devolve `ok` (ou `skipped`) pro `event_log`, mesmo quando a
 * tentativa em si falhou: o job DESTE handler é garantir que a linha de
 * `outbound_events` existe e levou uma tentativa, não acompanhar até o
 * desfecho final. Falha transitória vira `pending` com `next_retry_at`
 * agendado, e QUEM RETENTA a partir daí é o cron dedicado
 * (`rastreamento-outbound-retry`, a cada 5min), varrendo `outbound_events`
 * diretamente — não o `event_log`. Duas filas de retry pro mesmo trabalho
 * (esta e a do `event_log`) reagendariam a mesma tentativa duas vezes; UMA
 * fila com um dono claro é o que o item 1 do pedido pede.
 */
async function handle(row: EventRow): Promise<HandlerResult> {
  if (!row.entity_id) return { consumer_key: CONSUMER_KEY, status: "skipped", detail: "sem_entidade" };

  const admin = createAdminClient();

  const { data, error } = await admin
    .from("internal_events")
    .select(COLUNAS_DO_EVENTO_INTERNO)
    .eq("id", row.entity_id)
    .eq("organization_id", row.organization_id)
    .maybeSingle();

  if (error) {
    return {
      consumer_key: CONSUMER_KEY,
      status: "retry",
      retry_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      detail: `leitura do evento interno falhou: ${error.message}`,
    };
  }
  if (!data) return { consumer_key: CONSUMER_KEY, status: "skipped", detail: "evento_inexistente" };

  const evento = data as InternalEventRow;
  const providers = ROTEAMENTO[evento.event_type] ?? [];
  if (!providers.length) {
    return { consumer_key: CONSUMER_KEY, status: "skipped", detail: "sem_roteamento" };
  }

  const { data: habilitados } = await admin
    .from("integration_settings")
    .select("provider")
    .eq("organization_id", evento.organization_id)
    .eq("enabled", true)
    .in("provider", providers);
  const providersHabilitados = new Set(
    ((habilitados ?? []) as { provider: Provider }[]).map((r) => r.provider),
  );
  if (!providersHabilitados.size) {
    return { consumer_key: CONSUMER_KEY, status: "skipped", detail: "nenhum_provider_habilitado" };
  }

  let houveTentativa = false;
  const detalhes: string[] = [];

  for (const provider of providers) {
    if (!providersHabilitados.has(provider)) continue;

    const linha = await garantirLinhaDeDespacho(admin, evento, provider);
    if (linha.status !== "pending") continue; // terminal (sent/dead_letter) ou já em voo

    const desfecho = await tentarEnviarParaProvider(admin, evento, provider, linha.id);
    if (desfecho === "not_claimed") continue; // corrida com o cron de retry — não é erro

    houveTentativa = true;
    detalhes.push(`${provider}:${desfecho}`);
  }

  if (!houveTentativa) return { consumer_key: CONSUMER_KEY, status: "skipped", detail: "tudo_ja_resolvido" };

  logger.info("[rastreamento.despacho] 1ª tentativa concluída", {
    organizationId: evento.organization_id,
    internalEventId: evento.id,
    detalhes,
  });

  return { consumer_key: CONSUMER_KEY, status: "ok", detail: detalhes.join("; ") };
}

export const despachoDeRastreamentoHandler: EventHandler = {
  key: CONSUMER_KEY,
  events: ["tracking.internal_event_created"],
  handle,
};
