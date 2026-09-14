/**
 * GET  /api/v1/leads/[id]/compromissos — lista os compromissos deste lead.
 * POST /api/v1/leads/[id]/compromissos — cria um, com sincronização
 *   best-effort no Google Agenda do responsável (item 7 do pedido — nunca
 *   bloqueia o salvamento no CRM).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { TIPOS_DE_COMPROMISSO } from "@/lib/leads/compromissos/tipos";
import { criarEventoDeCompromisso } from "@/lib/leads/compromissos/google-sync";
import { registrarEventoInterno } from "@/lib/rastreamento/motor/registrar-evento";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const criarSchema = z.object({
  type: z.enum(TIPOS_DE_COMPROMISSO),
  title: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(1000).nullable().optional(),
  scheduled_at: z.string().datetime({ offset: true }),
  assigned_to: z.string().uuid().nullable().optional(),
});

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const authz = await requireRole("viewer", { requestId, resource: "crm_lead_appointments" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("crm_lead_appointments")
    .select("id, type, title, notes, scheduled_at, status, assigned_to, google_event_id, google_sync_error, created_at")
    .eq("organization_id", authz.org.orgId)
    .eq("lead_id", leadId)
    .order("scheduled_at", { ascending: true });

  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "crm_lead_appointments" });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;

  const parsed = criarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Compromisso inválido.", 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  const supabase = await createClient();
  const { data: lead, error: leadErr } = await supabase
    .from("crm_leads")
    .select("id, contact_id")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", leadId)
    .maybeSingle();
  if (leadErr) return fail("internal_error", leadErr.message, 500, { requestId });
  if (!lead) return fail("not_found", "Lead não encontrado.", 404, { requestId });

  const assignedTo = parsed.data.assigned_to ?? user.id;

  const admin = createAdminClient();
  const leadUrl = `${env.NEXT_PUBLIC_APP_URL}/app/leads/${leadId}`;
  const sync = await criarEventoDeCompromisso(admin, activeOrg.orgId, {
    assignedTo,
    title: parsed.data.title,
    notes: parsed.data.notes ?? null,
    scheduledAt: parsed.data.scheduled_at,
    leadUrl,
  });

  const { data: criado, error: insErr } = await supabase
    .from("crm_lead_appointments")
    .insert({
      organization_id: activeOrg.orgId,
      lead_id: leadId,
      type: parsed.data.type,
      title: parsed.data.title,
      notes: parsed.data.notes ?? null,
      scheduled_at: parsed.data.scheduled_at,
      assigned_to: assignedTo,
      created_by_user_id: user.id,
      google_event_id: sync.ok ? sync.eventId : null,
      // A sincronização é SEMPRE best-effort: o compromisso é gravado mesmo
      // quando ela falha, e o motivo fica visível na UI (item 7 do pedido).
      google_sync_error: sync.ok ? null : sync.motivo,
    })
    .select("id, type, title, notes, scheduled_at, status, assigned_to, google_event_id, google_sync_error, created_at")
    .single();
  if (insErr) return fail("internal_error", insErr.message, 500, { requestId });

  // Item 9 da decisão de arquitetura: marcar "reunião" dispara QUALIFIED no
  // máximo uma vez por lead — o índice único de `internal_events` garante a
  // idempotência, não precisa checar aqui.
  if (parsed.data.type === "reuniao" && (lead as { contact_id: string | null }).contact_id) {
    const { data: contato } = await admin
      .from("contacts")
      .select("visitor_id")
      .eq("id", (lead as { contact_id: string }).contact_id)
      .maybeSingle();
    if ((contato as { visitor_id: string | null } | null)?.visitor_id) {
      await registrarEventoInterno(admin, {
        organizationId: activeOrg.orgId,
        tipo: "QUALIFIED",
        visitorId: (contato as { visitor_id: string }).visitor_id,
        contactId: (lead as { contact_id: string }).contact_id,
        leadId,
        payload: { origem: "compromisso_reuniao" },
      });
    }
  }

  return ok(criado, { requestId, status: 201 });
}
