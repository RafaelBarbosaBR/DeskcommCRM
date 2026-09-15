/**
 * POST /api/v1/voice/calls — disca para um contato (ou telefone avulso).
 * GET /api/v1/voice/calls — histórico paginado (mais recente primeiro).
 *
 * `agent`+ nos dois — mesmo corte de `voice_calls_write`/`voice_calls_select`
 * (RLS já cobre a leitura; o gate de escrita aqui é redundante de propósito,
 * mesma doutrina do resto do produto: a rota nunca confia só na RLS para dar
 * a mensagem certa ao usuário errado).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { exigirVozLigada } from "@/lib/voice/guarda";
import { criarChamadaOutbound } from "@/lib/wacalls/calls";
import { getWacallsClient, wacallsFriendlyError } from "@/lib/wacalls/client";
import { resolveWacallsSession } from "@/lib/wacalls/session";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  contact_id: z.uuid().nullable().optional(),
  phone: z.string().min(8),
});

export async function POST(req: Request): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "voice_calls" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const db = await createClient();
  const guarda = await exigirVozLigada(db, org.orgId);
  if (guarda) return guarda;

  const sessao = await resolveWacallsSession(db, org.orgId);
  if (!sessao || sessao.status !== "open") {
    return fail("voice_not_paired", t("Nenhum número de voz pareado. Pareie em Conexões antes de discar."), 409, { requestId });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("invalid_body", t("Corpo inválido."), 400, { requestId });
  const phone = canonicalPhoneBR(parsed.data.phone);

  const client = getWacallsClient();
  if (!client) return fail("voice_not_configured", t("Serviço de chamada de voz indisponível."), 503, { requestId });

  try {
    const handle = await client.placeCall(sessao.wacallsSessionId!, phone.replace(/\D/g, ""), user.id);
    const linha = await criarChamadaOutbound(db, {
      organizationId: org.orgId,
      contactId: parsed.data.contact_id ?? null,
      wacallsCallId: handle.callId,
      peerPhone: phone,
      createdBy: user.id,
    });
    if (!linha) return fail("save_failed", t("A chamada foi discada, mas não consegui registrá-la."), 500, { requestId });
    return ok({ id: linha.id, status: linha.status }, { requestId, status: 201 });
  } catch (err) {
    return fail("voice_call_failed", wacallsFriendlyError(err), 502, { requestId });
  }
}

export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "voice_calls" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const url = new URL(req.url);
  const limite = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 200);

  const db = await createClient();
  const { data, error } = await db
    .from("voice_calls")
    .select("id, contact_id, direction, peer_phone, status, end_reason, started_at, answered_at, ended_at, duration_ms, owner_user_id")
    .eq("organization_id", org.orgId)
    .order("started_at", { ascending: false })
    .limit(limite);
  if (error) return fail("query_failed", error.message, 500, { requestId });

  return ok(data ?? [], { requestId });
}
