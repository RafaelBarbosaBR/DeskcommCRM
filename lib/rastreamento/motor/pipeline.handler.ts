import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import { registrarEventoInterno } from "./registrar-evento";

const CONSUMER_KEY = "rastreamento.pipeline";

const ok = (status: HandlerResult["status"], detail?: string): HandlerResult => ({
  consumer_key: CONSUMER_KEY,
  status,
  detail,
});

interface LeadRow {
  id: string;
  organization_id: string;
  status: string;
  contact_id: string | null;
  stage_id: string;
  value_cents: number | null;
  currency: string | null;
  closed_at: string | null;
}

interface ContactRow {
  visitor_id: string | null;
}

interface StageRow {
  is_qualified: boolean;
}

/**
 * Traduz mudança de pipeline pros 3 eventos internos que marcam progresso de
 * negócio (LEAD/QUALIFIED/PURCHASE). Relê tudo do banco — nunca confia no
 * payload do event_log, mesma regra já documentada em
 * `lib/conversoes/envio.handler.ts`.
 *
 * Fronteira que evita reportar a mesma venda duas vezes pra Meta (uma pelo
 * pipeline antigo de CTWA, outra por este): só age quando
 * `contacts.visitor_id is not null` — ou seja, o contato nasceu (ou foi
 * identificado) numa sessão que o tracker.js rastreou. O pipeline antigo
 * (lib/conversoes/) nunca escreve nessa coluna, e este handler nunca escreve
 * em `contacts.source_metadata` (o carimbo que o pipeline antigo lê) — as
 * duas fontes de verdade não se cruzam.
 */
async function handle(row: EventRow): Promise<HandlerResult> {
  if (!row.entity_id) return ok("skipped", "sem_entidade");

  const admin = createAdminClient();

  const { data, error } = await admin
    .from("crm_leads")
    .select("id, organization_id, status, contact_id, stage_id, value_cents, currency, closed_at")
    .eq("id", row.entity_id)
    .eq("organization_id", row.organization_id)
    .maybeSingle();

  if (error) {
    return {
      consumer_key: CONSUMER_KEY,
      status: "retry",
      retry_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      detail: `leitura do lead falhou: ${error.message}`,
    };
  }
  if (!data) return ok("skipped", "lead_inexistente");
  const lead = data as LeadRow;

  if (!lead.contact_id) return ok("skipped", "sem_contato");

  const { data: contactData } = await admin
    .from("contacts")
    .select("visitor_id")
    .eq("id", lead.contact_id)
    .eq("organization_id", row.organization_id)
    .maybeSingle();
  const contact = contactData as ContactRow | null;
  if (!contact?.visitor_id) return ok("skipped", "sem_visitor_id");

  // Snapshot de atribuição: o touchpoint mais recente deste contato (se
  // houver) vira prova anexada ao evento — nunca inventado, só o que já foi
  // capturado antes.
  const { data: touchpointData } = await admin
    .from("touchpoints")
    .select("id, fbclid, fbc, gclid, gbraid, wbraid, utm_source, utm_medium, utm_campaign")
    .eq("contact_id", lead.contact_id)
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const touchpoint = touchpointData as {
    id: string;
    fbclid: string | null;
    fbc: string | null;
    gclid: string | null;
    gbraid: string | null;
    wbraid: string | null;
    utm_source: string | null;
    utm_medium: string | null;
    utm_campaign: string | null;
  } | null;

  const payloadDeAtribuicao = touchpoint
    ? {
        fbclid: touchpoint.fbclid,
        fbc: touchpoint.fbc,
        gclid: touchpoint.gclid,
        gbraid: touchpoint.gbraid,
        wbraid: touchpoint.wbraid,
        utm_source: touchpoint.utm_source,
        utm_medium: touchpoint.utm_medium,
        utm_campaign: touchpoint.utm_campaign,
      }
    : {};

  const detalhes: string[] = [];

  if (row.event_type === "lead.created") {
    const registrado = await registrarEventoInterno(admin, {
      organizationId: row.organization_id,
      tipo: "LEAD",
      visitorId: contact.visitor_id,
      contactId: lead.contact_id,
      leadId: lead.id,
      touchpointId: touchpoint?.id ?? null,
      payload: payloadDeAtribuicao,
    });
    detalhes.push(registrado ? "LEAD registrado" : "LEAD ja existia");
  }

  if (row.event_type === "lead.stage_changed") {
    const { data: stageData } = await admin
      .from("crm_stages")
      .select("is_qualified")
      .eq("id", lead.stage_id)
      .eq("organization_id", row.organization_id)
      .maybeSingle();
    const stage = stageData as StageRow | null;
    if (stage?.is_qualified) {
      const registrado = await registrarEventoInterno(admin, {
        organizationId: row.organization_id,
        tipo: "QUALIFIED",
        visitorId: contact.visitor_id,
        contactId: lead.contact_id,
        leadId: lead.id,
        touchpointId: touchpoint?.id ?? null,
        payload: payloadDeAtribuicao,
      });
      detalhes.push(registrado ? "QUALIFIED registrado" : "QUALIFIED ja existia");
    }
  }

  if (
    (row.event_type === "lead.won" || row.event_type === "lead.stage_changed") &&
    lead.status === "won"
  ) {
    const registrado = await registrarEventoInterno(admin, {
      organizationId: row.organization_id,
      tipo: "PURCHASE",
      visitorId: contact.visitor_id,
      contactId: lead.contact_id,
      leadId: lead.id,
      touchpointId: touchpoint?.id ?? null,
      valorCentavos: lead.value_cents,
      moeda: lead.currency,
      ocorridoEm: lead.closed_at ? new Date(lead.closed_at) : undefined,
      payload: payloadDeAtribuicao,
    });
    detalhes.push(registrado ? "PURCHASE registrado" : "PURCHASE ja existia");
  }

  if (!detalhes.length) return ok("skipped", "nenhum_mapeamento_para_este_evento");
  return ok("ok", detalhes.join("; "));
}

export const pipelineDeRastreamentoHandler: EventHandler = {
  key: CONSUMER_KEY,
  events: ["lead.created", "lead.stage_changed", "lead.won"],
  handle,
};
