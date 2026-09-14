/**
 * A leitura das 4 seções da tela de auditoria de rastreamento
 * (`/app/integrations/rastreamento/auditoria`) — nunca escreve, só lê, sempre
 * filtrado por `organization_id` de fonte confiável (o chamador passa o da
 * sessão ativa; nenhuma função aqui aceita um `organization_id` de query
 * param ou body).
 *
 * As 4 tabelas (`internal_events`, `outbound_events`, `platform_event_logs`,
 * `api_audit_log`) têm RLS ligada com ZERO policy — só o `service_role` lê,
 * então todo chamador passa um admin client e filtra à mão.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { TipoDeEventoInterno } from "@/lib/rastreamento/motor/types";

const LIMITE_PADRAO = 50;

// ─── (a) Eventos internos ───────────────────────────────────────────────────

export interface LinhaDeEventoInterno {
  id: string;
  eventType: TipoDeEventoInterno;
  occurredAt: string;
  /** Link direto: `/app/leads/{id}` — URL estável que resolve pro quadro certo (app/app/leads/[id]/page.tsx). */
  leadId: string | null;
  leadTitle: string | null;
  /** Sem lead: `/app/contacts/{id}`. */
  contactId: string | null;
  contactName: string | null;
}

export async function lerEventosInternos(
  admin: SupabaseClient,
  organizationId: string,
  opts: { tipo?: TipoDeEventoInterno; limit?: number } = {},
): Promise<LinhaDeEventoInterno[]> {
  let consulta = admin
    .from("internal_events")
    .select("id, event_type, occurred_at, lead_id, contact_id, crm_leads(title), contacts(display_name)")
    .eq("organization_id", organizationId)
    .order("occurred_at", { ascending: false })
    .limit(opts.limit ?? LIMITE_PADRAO);
  if (opts.tipo) consulta = consulta.eq("event_type", opts.tipo);

  const { data } = await consulta;
  return ((data ?? []) as unknown[]).map((raw) => {
    const l = raw as {
      id: string;
      event_type: TipoDeEventoInterno;
      occurred_at: string;
      lead_id: string | null;
      contact_id: string | null;
      crm_leads: { title: string } | { title: string }[] | null;
      contacts: { display_name: string | null } | { display_name: string | null }[] | null;
    };
    const lead = Array.isArray(l.crm_leads) ? l.crm_leads[0] : l.crm_leads;
    const contact = Array.isArray(l.contacts) ? l.contacts[0] : l.contacts;
    return {
      id: l.id,
      eventType: l.event_type,
      occurredAt: l.occurred_at,
      leadId: l.lead_id,
      leadTitle: lead?.title ?? null,
      contactId: l.contact_id,
      contactName: contact?.display_name ?? null,
    };
  });
}

// ─── (b) Fila de envio (outbound_events) ────────────────────────────────────

export type StatusDeEnvio = "pending" | "processing" | "sent" | "failed" | "dead_letter";
export type ProviderDeRastreamento = "META" | "GA4" | "GOOGLE_ADS";

export interface LinhaDaFilaDeEnvio {
  id: string;
  provider: ProviderDeRastreamento;
  eventName: string | null;
  eventType: TipoDeEventoInterno | null;
  status: StatusDeEnvio;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export async function lerFilaDeEnvio(
  admin: SupabaseClient,
  organizationId: string,
  opts: { status?: StatusDeEnvio; provider?: ProviderDeRastreamento; limit?: number } = {},
): Promise<LinhaDaFilaDeEnvio[]> {
  let consulta = admin
    .from("outbound_events")
    .select(
      "id, provider, event_name, status, attempt_count, last_attempt_at, next_retry_at, error_message, created_at, internal_events(event_type)",
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? LIMITE_PADRAO);
  if (opts.status) consulta = consulta.eq("status", opts.status);
  if (opts.provider) consulta = consulta.eq("provider", opts.provider);

  const { data } = await consulta;
  return ((data ?? []) as unknown[]).map((raw) => {
    const l = raw as {
      id: string;
      provider: ProviderDeRastreamento;
      event_name: string | null;
      status: StatusDeEnvio;
      attempt_count: number;
      last_attempt_at: string | null;
      next_retry_at: string | null;
      error_message: string | null;
      created_at: string;
      internal_events: { event_type: TipoDeEventoInterno } | { event_type: TipoDeEventoInterno }[] | null;
    };
    const internal = Array.isArray(l.internal_events) ? l.internal_events[0] : l.internal_events;
    return {
      id: l.id,
      provider: l.provider,
      eventName: l.event_name,
      eventType: internal?.event_type ?? null,
      status: l.status,
      attemptCount: l.attempt_count,
      lastAttemptAt: l.last_attempt_at,
      nextRetryAt: l.next_retry_at,
      errorMessage: l.error_message,
      createdAt: l.created_at,
    };
  });
}

// ─── (c) Logs de envio por plataforma (platform_event_logs) ────────────────

export type StatusDoLog = "ok" | "erro";

export interface LinhaDeLogDePlataforma {
  id: string;
  provider: ProviderDeRastreamento;
  eventName: string | null;
  status: StatusDoLog;
  errorMessage: string | null;
  attemptedAt: string;
}

export async function lerLogsDePlataforma(
  admin: SupabaseClient,
  organizationId: string,
  opts: { status?: StatusDoLog; limit?: number } = {},
): Promise<LinhaDeLogDePlataforma[]> {
  let consulta = admin
    .from("platform_event_logs")
    .select("id, provider, event_name, status, error_message, attempted_at")
    .eq("organization_id", organizationId)
    .order("attempted_at", { ascending: false })
    .limit(opts.limit ?? LIMITE_PADRAO);
  if (opts.status) consulta = consulta.eq("status", opts.status);

  const { data } = await consulta;
  return ((data ?? []) as {
    id: string;
    provider: ProviderDeRastreamento;
    event_name: string | null;
    status: StatusDoLog;
    error_message: string | null;
    attempted_at: string;
  }[]).map((l) => ({
    id: l.id,
    provider: l.provider,
    eventName: l.event_name,
    status: l.status,
    errorMessage: l.error_message,
    attemptedAt: l.attempted_at,
  }));
}

// ─── (d) Ações administrativas (api_audit_log) ─────────────────────────────

export interface LinhaDeAcaoAdministrativa {
  id: string;
  action: string;
  /**
   * O UUID de quem agiu, cru — sem resolução de nome. `api_audit_log` não
   * tem FK pra tabela de perfil nenhuma (linha de sistema/webhook não tem
   * ator humano), e inventar uma junção aqui arriscaria uma tabela que não
   * existe. Quem lê a tela já tem o UUID pra cruzar com `/admin/users`
   * quando precisar do nome — mostrar "—" seria menos verdade que o UUID.
   */
  actorUserId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export async function lerAcoesAdministrativas(
  admin: SupabaseClient,
  organizationId: string,
  opts: { action?: string; limit?: number } = {},
): Promise<LinhaDeAcaoAdministrativa[]> {
  let consulta = admin
    .from("api_audit_log")
    .select("id, action, actor_user_id, resource_type, resource_id, metadata, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? LIMITE_PADRAO);
  if (opts.action) consulta = consulta.eq("action", opts.action);

  const { data } = await consulta;
  return ((data ?? []) as {
    id: string;
    action: string;
    actor_user_id: string | null;
    resource_type: string | null;
    resource_id: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
  }[]).map((l) => ({
    id: l.id,
    action: l.action,
    actorUserId: l.actor_user_id,
    resourceType: l.resource_type,
    resourceId: l.resource_id,
    metadata: l.metadata ?? {},
    createdAt: l.created_at,
  }));
}

/** As ações administrativas distintas já vistas nesta org — vira os chips do filtro (d). */
export async function lerAcoesDistintas(
  admin: SupabaseClient,
  organizationId: string,
): Promise<string[]> {
  const { data } = await admin
    .from("api_audit_log")
    .select("action")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(500);
  const vistas = new Set(((data ?? []) as { action: string }[]).map((l) => l.action));
  return [...vistas].sort();
}
