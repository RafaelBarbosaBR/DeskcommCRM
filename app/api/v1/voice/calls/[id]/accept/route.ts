/**
 * POST /api/v1/voice/calls/[id]/accept — atende uma chamada entrando e
 * assume a linha (grava `owner_user_id` = quem atendeu).
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { resolveVoiceCall } from "@/lib/wacalls/calls";
import { getWacallsClient, wacallsFriendlyError } from "@/lib/wacalls/client";
import { resolveWacallsSession } from "@/lib/wacalls/session";

export const dynamic = "force-dynamic";

export async function POST(
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
  if (call.status === "ended") return fail("voice_call_ended", t("Esta chamada já foi encerrada."), 409, { requestId });
  if (call.ownerUserId !== null && call.ownerUserId !== user.id) {
    return fail("voice_call_taken", t("Outra pessoa já assumiu esta chamada."), 409, { requestId });
  }

  const sessao = await resolveWacallsSession(db, org.orgId);
  const client = getWacallsClient();
  if (!client || !sessao?.wacallsSessionId) {
    return fail("voice_not_configured", t("Serviço de chamada de voz indisponível."), 503, { requestId });
  }

  try {
    await client.acceptCall(sessao.wacallsSessionId, call.wacallsCallId, user.id);
  } catch (err) {
    return fail("voice_accept_failed", wacallsFriendlyError(err), 502, { requestId });
  }

  // A confirmação de 'connected' vem do bridge de eventos quando o servidor
  // avisar — aqui só marcamos QUEM assumiu, para outro agent+ não disputar a
  // mesma chamada enquanto o evento não chega.
  await db.from("voice_calls").update({ owner_user_id: user.id }).eq("organization_id", org.orgId).eq("id", call.id);

  return ok({ id: call.id }, { requestId });
}
