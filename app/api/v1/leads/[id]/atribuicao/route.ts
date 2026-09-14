/**
 * GET /api/v1/leads/[id]/atribuicao — bloco só-leitura do item 4b: o que o
 * tracker automático capturou de verdade pro contato deste lead. `touchpoints`
 * tem RLS zero-políticas (só service_role lê), daí o admin client aqui —
 * mesmo motivo de `lib/conversoes/estado-da-conexao.ts`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { lerAtribuicaoDoContato } from "@/lib/leads/atribuicao-de-rastreamento";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("viewer", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data: lead, error } = await supabase
    .from("crm_leads")
    .select("id, contact_id")
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!lead) return fail("not_found", "Lead não encontrado.", 404, { requestId });

  const admin = createAdminClient();
  const atribuicao = await lerAtribuicaoDoContato(admin, (lead as { contact_id: string | null }).contact_id);
  return ok(atribuicao, { requestId });
}
