/**
 * PATCH  /api/v1/leads/[id]/compromissos/[compromissoId] — reagendar
 *   (edita só `scheduled_at`), concluir, cancelar ou reabrir.
 * DELETE /api/v1/leads/[id]/compromissos/[compromissoId] — remove de vez,
 *   removendo também o evento do Google se existir.
 *
 * Sincronização SEMPRE best-effort (item 7 do pedido): nenhuma falha do
 * Google impede a escrita no CRM — só fica registrada em `google_sync_error`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { STATUS_DE_COMPROMISSO } from "@/lib/leads/compromissos/tipos";
import {
  atualizarEventoDeCompromisso,
  criarEventoDeCompromisso,
  removerEventoDeCompromisso,
} from "@/lib/leads/compromissos/google-sync";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const alterarSchema = z
  .object({
    scheduled_at: z.string().datetime({ offset: true }).optional(),
    status: z.enum(STATUS_DE_COMPROMISSO).optional(),
  })
  .refine((v) => v.scheduled_at !== undefined || v.status !== undefined, {
    message: "Informe scheduled_at ou status.",
  });

interface RouteCtx {
  params: Promise<{ id: string; compromissoId: string }>;
}

interface Compromisso {
  id: string;
  organization_id: string;
  lead_id: string;
  title: string;
  notes: string | null;
  scheduled_at: string;
  status: "pending" | "completed" | "cancelled";
  assigned_to: string | null;
  google_event_id: string | null;
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId, compromissoId } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "crm_lead_appointments" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const parsed = alterarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  const supabase = await createClient();
  const { data: atual, error: leituraErr } = await supabase
    .from("crm_lead_appointments")
    .select("id, organization_id, lead_id, title, notes, scheduled_at, status, assigned_to, google_event_id")
    .eq("organization_id", activeOrg.orgId)
    .eq("lead_id", leadId)
    .eq("id", compromissoId)
    .maybeSingle();
  if (leituraErr) return fail("internal_error", leituraErr.message, 500, { requestId });
  if (!atual) return fail("not_found", "Compromisso não encontrado.", 404, { requestId });
  const compromisso = atual as Compromisso;

  const admin = createAdminClient();
  const leadUrl = `${env.NEXT_PUBLIC_APP_URL}/app/leads/${leadId}`;
  const patch: Record<string, unknown> = {};
  let googleSyncError: string | null | undefined;

  if (parsed.data.scheduled_at !== undefined) {
    patch.scheduled_at = parsed.data.scheduled_at;
  }

  const novoStatus = parsed.data.status;

  if (novoStatus === "cancelled") {
    // Cancelar remove o evento do Google — não deixa "sujeira" de compromisso
    // cancelado aparecendo na agenda (item 7 do pedido).
    patch.status = "cancelled";
    if (compromisso.google_event_id) {
      const remocao = await removerEventoDeCompromisso(
        admin,
        activeOrg.orgId,
        compromisso.google_event_id,
        compromisso.assigned_to,
      );
      if (remocao.ok) {
        patch.google_event_id = null;
        googleSyncError = null;
      } else {
        googleSyncError = remocao.motivo;
      }
    }
  } else if (novoStatus === "completed") {
    // Concluir MANTÉM o evento — é histórico legítimo de algo que aconteceu,
    // não precisa remover (item 7 do pedido).
    patch.status = "completed";
  } else if (novoStatus === "pending") {
    // Reabrir: se o evento tinha sido removido (veio de cancelado), recria.
    patch.status = "pending";
    if (!compromisso.google_event_id) {
      const criacao = await criarEventoDeCompromisso(admin, activeOrg.orgId, {
        assignedTo: compromisso.assigned_to,
        title: compromisso.title,
        notes: compromisso.notes,
        scheduledAt: (patch.scheduled_at as string) ?? compromisso.scheduled_at,
        leadUrl,
      });
      patch.google_event_id = criacao.ok ? criacao.eventId : null;
      googleSyncError = criacao.ok ? null : criacao.motivo;
    }
  } else if (parsed.data.scheduled_at !== undefined && compromisso.google_event_id) {
    // Só reagendou (sem mudar status) e já tinha evento — PATCH no mesmo
    // evento, nunca cria um novo (item 7 do pedido).
    const atualizacao = await atualizarEventoDeCompromisso(
      admin,
      activeOrg.orgId,
      compromisso.google_event_id,
      {
        assignedTo: compromisso.assigned_to,
        title: compromisso.title,
        notes: compromisso.notes,
        scheduledAt: parsed.data.scheduled_at,
        leadUrl,
      },
    );
    patch.google_event_id = atualizacao.ok ? atualizacao.eventId : compromisso.google_event_id;
    googleSyncError = atualizacao.ok ? null : atualizacao.motivo;
  }

  if (googleSyncError !== undefined) patch.google_sync_error = googleSyncError;
  patch.updated_at = new Date().toISOString();

  const { data: salvo, error: updErr } = await supabase
    .from("crm_lead_appointments")
    .update(patch)
    .eq("organization_id", activeOrg.orgId)
    .eq("id", compromissoId)
    .select("id, type, title, notes, scheduled_at, status, assigned_to, google_event_id, google_sync_error, created_at")
    .maybeSingle();
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  return ok(salvo, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId, compromissoId } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "crm_lead_appointments" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data: atual, error: leituraErr } = await supabase
    .from("crm_lead_appointments")
    .select("id, assigned_to, google_event_id")
    .eq("organization_id", activeOrg.orgId)
    .eq("lead_id", leadId)
    .eq("id", compromissoId)
    .maybeSingle();
  if (leituraErr) return fail("internal_error", leituraErr.message, 500, { requestId });
  if (!atual) return fail("not_found", "Compromisso não encontrado.", 404, { requestId });

  const compromisso = atual as { id: string; assigned_to: string | null; google_event_id: string | null };
  if (compromisso.google_event_id) {
    const admin = createAdminClient();
    // Best-effort: falha aqui nunca impede a exclusão no CRM.
    await removerEventoDeCompromisso(admin, activeOrg.orgId, compromisso.google_event_id, compromisso.assigned_to);
  }

  const { error: delErr } = await supabase
    .from("crm_lead_appointments")
    .delete()
    .eq("organization_id", activeOrg.orgId)
    .eq("id", compromissoId);
  if (delErr) return fail("internal_error", delErr.message, 500, { requestId });

  return ok({ deleted: true }, { requestId });
}
