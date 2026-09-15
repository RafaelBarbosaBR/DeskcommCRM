/**
 * POST /api/v1/voice/calls/[id]/webrtc — relay de sinalização SDP entre o
 * navegador (`hooks/voice/useVoiceCallSession.ts`) e o servidor WaCalls.
 *
 * Contrato confirmado na fonte do servidor (`cmd/server/httpapi.go`,
 * `doWebRTC`): corpo `{sdp_offer: string}`, resposta `{sdp_answer: string}` —
 * uma troca ÚNICA (oferta → resposta), não uma negociação de vários passos.
 * O pion (biblioteca WebRTC do servidor) resolve ICE por trickle EMBUTIDO no
 * SDP, então não há rota separada de candidato ICE.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { podeEncerrar, resolveVoiceCall } from "@/lib/wacalls/calls";
import { getWacallsClient, wacallsFriendlyError } from "@/lib/wacalls/client";
import { resolveWacallsSession } from "@/lib/wacalls/session";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
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
  // Mesmo gate de "quem pode mexer nesta chamada" do encerrar — sinalização
  // WebRTC de outra pessoa não pode ser injetada na ligação de alguém.
  if (!podeEncerrar(call, user.id)) {
    return fail("forbidden", t("Você não está nesta chamada."), 403, { requestId });
  }

  const parsed = z.object({ sdp_offer: z.string().min(1) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("invalid_body", t("Corpo inválido."), 400, { requestId });

  const sessao = await resolveWacallsSession(db, org.orgId);
  const client = getWacallsClient();
  if (!client || !sessao?.wacallsSessionId) {
    return fail("voice_not_configured", t("Serviço de chamada de voz indisponível."), 503, { requestId });
  }

  try {
    const resposta = await client.relayWebrtcSignal(sessao.wacallsSessionId, call.wacallsCallId, parsed.data.sdp_offer);
    return ok({ sdp_answer: resposta.sdpAnswer }, { requestId });
  } catch (err) {
    return fail("voice_webrtc_failed", wacallsFriendlyError(err), 502, { requestId });
  }
}
