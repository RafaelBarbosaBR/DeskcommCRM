/**
 * GET/DELETE /api/v1/voice/sessions — status da sessão de pareamento da
 * organização ativa, e desparear. Iniciar/reparear é
 * `POST /api/v1/voice/sessions/pair` (rota irmã, corpo vazio — ver lá).
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { despareaVoz } from "@/lib/voice/desparear";
import { resolveWacallsSession } from "@/lib/wacalls/session";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "voice_sessions" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  // Lê SÓ o que está gravado no banco — não o servidor ao vivo. O bridge de
  // eventos (`lib/wacalls/events-bridge.ts`) mantém isto em sincronia via o
  // stream SSE, inclusive o QR (que só existe lá, nunca por uma rota REST de
  // "status" — o servidor de terceiro não tem uma). Chamar o servidor aqui
  // duplicaria uma fonte que já está sendo mantida em tempo real.
  const db = await createClient();
  const sessao = await resolveWacallsSession(db, org.orgId);
  if (!sessao) return ok({ paired: false, status: null, qr: null, jid: null }, { requestId });

  return ok(
    { paired: sessao.status === "open", status: sessao.status, qr: sessao.qr, jid: sessao.wacallsJid },
    { requestId },
  );
}

export async function DELETE(): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "voice_sessions" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  // Sem guarda de "voz ligada" aqui, de propósito: desparear precisa
  // continuar possível mesmo depois que a organização já desligou a opção
  // (limpar uma sessão órfã), ou se a instalação perdeu a configuração do
  // serviço no meio do caminho.
  const db = await createClient();
  const resultado = await despareaVoz(db, org.orgId);
  if (!resultado.ok) return fail("voice_unpair_failed", t(resultado.erro), 500, { requestId });

  await audit({
    action: "voice.disabled",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    requestId,
    metadata: { motivo: "desparear" },
  });

  return ok({ paired: false }, { requestId });
}
