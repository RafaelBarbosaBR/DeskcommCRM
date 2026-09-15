/**
 * POST /api/v1/team/invites/[id]/revoke — impede o aceite mesmo com o link
 * ainda dentro da validade.
 *
 * O token é uma assinatura HMAC autossuficiente — sem esta rota, "cancelar"
 * um convite emitido por engano (papel errado, e-mail errado) não existia:
 * o link continuava valendo até o TTL de 24h esgotar sozinho, e a única
 * defesa era torcer para ninguém clicar. `lib/auth/aplicar-convite.ts` é
 * quem lê `status='revoked'` e recusa o aceite — esta rota só grava a
 * decisão.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await params;

  const authz = await requireRole("admin", { requestId, resource: "team_invites" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const db = await createClient();
  const { data: linhaRaw } = await db
    .from("team_invites")
    .select("id, email, status")
    .eq("organization_id", org.orgId)
    .eq("id", id)
    .maybeSingle();
  const linha = linhaRaw as { id: string; email: string; status: string } | null;
  if (!linha) return fail("not_found", t("Convite não encontrado."), 404, { requestId });

  // Idempotente: revogar duas vezes, ou revogar um convite já aceito
  // (histórico, não impede mais nada — o vínculo já existe em
  // `user_organizations`), não pode virar erro na cara de quem clicou.
  if (linha.status === "revoked") return ok({ id: linha.id, status: "revoked" }, { requestId });

  const { error } = await db
    .from("team_invites")
    .update({ status: "revoked", revoked_at: new Date().toISOString(), revoked_by: user.id })
    .eq("id", linha.id)
    .eq("organization_id", org.orgId);
  if (error) return fail("save_failed", error.message, 500, { requestId });

  await audit({
    action: "member.invite_revoked",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "membership",
    resourceId: linha.id,
    requestId,
    metadata: { email: linha.email, status_anterior: linha.status },
  });

  return ok({ id: linha.id, status: "revoked" }, { requestId });
}
