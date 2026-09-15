/**
 * DELETE /api/v1/voice/calls/[id] — encerra uma chamada em andamento.
 *
 * Quem pode: `podeEncerrar` (dono da linha, ou qualquer agent+ se ninguém
 * assumiu ainda — ver `lib/wacalls/calls.ts`). Não é `requireRole` puro: uma
 * chamada JÁ tem dono, e o dono deve poder encerrar mesmo que outro agent+
 * mais "forte" não devesse conseguir derrubar a ligação de um colega.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { podeEncerrar, resolveVoiceCall } from "@/lib/wacalls/calls";
import { getWacallsClient, wacallsFriendlyError } from "@/lib/wacalls/client";
import { resolveWacallsSession } from "@/lib/wacalls/session";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await params;
  const authz = await requireRole("agent", { requestId, resource: "voice_calls" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const db = await createClient();
  const call = await resolveVoiceCall(db, org.orgId, id);
  if (!call) return fail("not_found", t("Chamada não encontrada."), 404, { requestId });
  if (!podeEncerrar(call, user.id)) {
    return fail("forbidden", t("Só quem está na linha pode encerrar esta chamada."), 403, { requestId });
  }

  const sessao = await resolveWacallsSession(db, org.orgId);
  const client = getWacallsClient();
  if (client && sessao?.wacallsSessionId) {
    try {
      await client.endCall(sessao.wacallsSessionId, call.wacallsCallId);
    } catch (err) {
      // O bridge de eventos (`events-bridge.ts`) fecha o estado no banco
      // quando o servidor confirmar o fim, mesmo que esta chamada REST falhe
      // — não é motivo para a rota travar quem quer desligar.
      return fail("voice_end_call_failed", wacallsFriendlyError(err), 502, { requestId });
    }
  }

  return ok({ id: call.id }, { requestId });
}
