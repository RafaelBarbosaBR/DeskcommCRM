/** POST /api/v1/voice/calls/[id]/reject — recusa uma chamada entrando sem atender. */
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
  const { org } = authz;

  const db = await createClient();
  const call = await resolveVoiceCall(db, org.orgId, id);
  if (!call) return fail("not_found", t("Chamada não encontrada."), 404, { requestId });
  if (call.status === "ended") return ok({ id: call.id }, { requestId });

  const sessao = await resolveWacallsSession(db, org.orgId);
  const client = getWacallsClient();
  if (client && sessao?.wacallsSessionId) {
    try {
      await client.rejectCall(sessao.wacallsSessionId, call.wacallsCallId);
    } catch (err) {
      return fail("voice_reject_failed", wacallsFriendlyError(err), 502, { requestId });
    }
  }

  return ok({ id: call.id }, { requestId });
}
