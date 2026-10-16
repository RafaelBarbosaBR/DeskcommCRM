/**
 * POST /api/v1/leads/[id]/notes — o comentário manual na linha do tempo (16/10).
 *
 * Não é tabela nova: `crm_lead_activities` já tem o tipo `note` no vocabulário
 * fechado (`lib/leads/activity-vocabulary.ts`), hoje escrito pelo webhook de
 * captação e pela ferramenta da IA. Esta rota é o QUARTO escritor — o humano,
 * pelo dossiê — usando o MESMO `emitLeadActivity` dos outros três, então a
 * linha nova entra pela porta que a timeline já sabe ler (nenhuma mudança em
 * `LeadTimeline.tsx`/`useLeadTimeline.ts`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { traduzir } from "@/lib/i18n/dicionario";
import { addLeadNoteSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: leadId } = await ctx.params;

  const supabase = await createClient();
  // Escrita é agent+ (spec 13 §4) — viewer só lê.
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  try {
    const input = await validateRequest(addLeadNoteSchema, req);

    // O lead vem pela RLS do caller, e o filtro de organização é defesa em
    // profundidade (mesmo padrão de `[id]/clone`) — nunca confia no body.
    const { data: lead, error: selErr } = await supabase
      .from("crm_leads")
      .select("id, contact_id")
      .eq("id", leadId)
      .eq("organization_id", authz.org.orgId)
      .maybeSingle();
    if (selErr) return fail("internal_error", selErr.message, 500, { requestId });
    if (!lead) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });

    const emitido = await emitLeadActivity(supabase, {
      organizationId: authz.org.orgId,
      leadId,
      contactId: (lead as { contact_id: string | null }).contact_id,
      type: "note",
      sourceModule: "crm_dossie",
      actor: { type: "user", id: authz.user.id },
      reason: input.text,
    });
    // Aqui a atividade NÃO é efeito colateral de outra escrita (como no
    // clone) — é o próprio pedido. Falhar baixo esconderia do usuário que o
    // comentário que ele acabou de escrever não foi salvo.
    if (!emitido.ok) {
      return fail("internal_error", emitido.error ?? t("Não consegui salvar o comentário."), 500, {
        requestId,
      });
    }

    return ok({ saved: true }, { requestId, status: 201 });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
