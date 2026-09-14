/**
 * POST /api/v1/leads/[id]/notes — item 5 do pedido: texto livre, autor e
 * data automáticos (já são colunas de `crm_lead_activities`), várias notas
 * por lead — nunca um campo único que se sobrescreve.
 *
 * Não cria tabela nova: `crm_lead_activities.type = "note"` já está no
 * vocabulário fechado (`ActivityType`) desde sempre, só sem escritor de
 * produção nenhum até agora.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Item 6 do pedido: mesma checagem no servidor, nunca só no maxLength do input.
const notaSchema = z.object({ body: z.string().trim().min(1).max(1000) });

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;

  const parsed = notaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Nota inválida (1 a 1000 caracteres).", 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  const supabase = await createClient();
  const { data: lead, error } = await supabase
    .from("crm_leads")
    .select("id, contact_id")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", leadId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!lead) return fail("not_found", "Lead não encontrado.", 404, { requestId });

  const resultado = await emitLeadActivity(supabase, {
    organizationId: activeOrg.orgId,
    leadId,
    contactId: (lead as { contact_id: string | null }).contact_id,
    type: "note",
    sourceModule: "crm",
    sourceId: leadId,
    actor: { type: "user", id: user.id },
    reason: parsed.data.body,
  });
  if (!resultado.ok) {
    return fail("internal_error", resultado.error ?? "Não consegui salvar a nota.", 500, { requestId });
  }

  return ok({ saved: true }, { requestId, status: 201 });
}
