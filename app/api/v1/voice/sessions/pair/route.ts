/**
 * POST /api/v1/voice/sessions/pair — inicia (primeira vez) ou reinicia
 * (depois de um logout) o pareamento por QR.
 *
 * Gated pelos DOIS eixos (`exigirVozLigada`): a instalação precisa ter o
 * serviço configurado E a organização precisa ter aceitado o risco antes de
 * sequer tentar abrir uma sessão — pareamento não é o passo que liga a
 * feature, é o que ela faz DEPOIS de ligada.
 *
 * O QR em si NÃO volta nesta resposta — o servidor WaCalls não o devolve na
 * criação/pareamento (confirmado na fonte: `POST /api/sessions` devolve só
 * `{id}`, `POST /{sid}/pair` devolve 204). Ele chega pelo stream SSE
 * (`lib/wacalls/events-bridge.ts`) e fica gravado em `wacalls_sessions.qr` —
 * a tela consulta `GET /api/v1/voice/sessions` (com polling curto) até
 * aparecer.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { exigirVozLigada } from "@/lib/voice/guarda";
import { getWacallsClient, wacallsFriendlyError } from "@/lib/wacalls/client";
import { registrarSessaoCriada, resolveWacallsSession } from "@/lib/wacalls/session";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "voice_sessions" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;

  const db = await createClient();
  const guarda = await exigirVozLigada(db, org.orgId);
  if (guarda) return guarda;

  const client = getWacallsClient();
  if (!client) {
    return fail("voice_not_configured", t("Esta instalação não tem o serviço de chamada de voz configurado."), 503, { requestId });
  }

  const existente = await resolveWacallsSession(db, org.orgId);

  try {
    if (existente?.wacallsSessionId && existente.status !== "open") {
      // Já existe conta no servidor (criada antes) e ela não está pareada
      // agora — reemite QR para a MESMA conta, preservando o histórico de
      // `voice_calls` que referencia esta organização.
      await client.pairSession(existente.wacallsSessionId);
      return ok({ status: "qr" }, { requestId });
    }
    if (existente?.status === "open") {
      // Já pareada — nada a fazer (idempotente: clicar "parear" de novo com
      // a sessão já ativa não é erro).
      return ok({ status: "open" }, { requestId });
    }

    // Primeira vez desta organização: cria a conta. O nome é só rótulo
    // exibido no lado do servidor (não temos UI própria dele) — usa o nome
    // da organização para quem olhar os logs do WaCalls identificar de qual
    // instalação/tenant é aquela conta.
    const criada = await client.createSession(org.name);
    await registrarSessaoCriada(db, org.orgId, criada.id);
    return ok({ status: "connecting" }, { requestId, status: 201 });
  } catch (err) {
    return fail("voice_pair_failed", wacallsFriendlyError(err), 502, { requestId });
  }
}
