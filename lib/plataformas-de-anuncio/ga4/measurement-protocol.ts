import { logger } from "@/lib/logger";
import type { ConversaoOffline, ResultadoDeEnvio, TransporteDeConversao } from "../types";
import type { CredencialGa4 } from "./credenciais";

/**
 * Measurement Protocol — só recebe LEAD/QUALIFIED/PURCHASE (o motor de
 * rastreamento nunca despacha PAGE_VIEW/CONTACT pro servidor de GA4, esses
 * dois são só client-side via gtag — item 5 do pedido).
 *
 * O MP é "fire-and-forget" por desenho do Google: em produção devolve 204
 * mesmo quando o corpo é inválido — não existe "aceito/rejeitado" real nesse
 * caminho. `enviarDebug` chama o endpoint de validação (que DEVOLVE
 * `validationMessages`) e é o que o botão "Testar conexão" da tela usa —
 * único lugar onde o GA4 confirma algo de verdade.
 */
const ENDPOINT_PRODUCAO = "https://www.google-analytics.com/mp/collect";
const ENDPOINT_DEBUG = "https://www.google-analytics.com/debug/mp/collect";
const TEMPO_LIMITE_MS = 10_000;

const NOME_GA4: Record<string, string> = {
  Lead: "generate_lead",
  Qualified: "qualified_lead",
  Purchase: "purchase",
};

function corpoDoEvento(conversao: ConversaoOffline): Record<string, unknown> | null {
  const nome = NOME_GA4[conversao.evento];
  if (!nome || !conversao.clientId) return null;

  return {
    client_id: conversao.clientId,
    events: [
      {
        name: nome,
        params: {
          transaction_id: conversao.eventoId,
          ...(conversao.valorCentavos != null
            ? {
                value: conversao.valorCentavos / 100,
                currency: (conversao.moeda ?? "BRL").toUpperCase(),
              }
            : {}),
        },
      },
    ],
  };
}

async function enviar(
  credencial: CredencialGa4,
  conversao: ConversaoOffline,
): Promise<ResultadoDeEnvio> {
  const corpo = corpoDoEvento(conversao);
  if (!corpo) {
    return { tipo: "permanente", detalhe: `evento "${conversao.evento}" sem client_id ou fora do mapa GA4` };
  }

  const url = `${ENDPOINT_PRODUCAO}?measurement_id=${encodeURIComponent(
    credencial.measurementId,
  )}&api_secret=${encodeURIComponent(credencial.apiSecret)}`;

  let resposta: Response;
  try {
    resposta = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    });
  } catch (erro) {
    return { tipo: "transitorio", detalhe: erro instanceof Error ? erro.message : "falha de rede" };
  }

  // MP não recusa payload com 4xx/5xx no caminho de produção — 204 é o único
  // desfecho documentado. Qualquer outro status é anomalia de rede/proxy, não
  // recusa da plataforma; tratada como transitória por precaução.
  if (resposta.status === 204 || resposta.ok) return { tipo: "ok" };

  logger.warn("[rastreamento.ga4] status inesperado do Measurement Protocol", {
    status: resposta.status,
    leadId: conversao.leadId,
  });
  return { tipo: "transitorio", detalhe: `status inesperado: ${resposta.status}` };
}

/** Usado só pelo "Testar conexão" da tela — nunca no despacho normal. */
export async function enviarDebug(
  credencial: CredencialGa4,
  conversao: ConversaoOffline,
): Promise<{ ok: boolean; mensagens: string[] }> {
  const corpo = corpoDoEvento(conversao);
  if (!corpo) return { ok: false, mensagens: ["evento sem client_id ou fora do mapa GA4"] };

  const url = `${ENDPOINT_DEBUG}?measurement_id=${encodeURIComponent(
    credencial.measurementId,
  )}&api_secret=${encodeURIComponent(credencial.apiSecret)}`;

  const resposta = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
  });

  if (!resposta.ok) {
    return { ok: false, mensagens: [`GA4 devolveu status ${resposta.status}`] };
  }
  const json = (await resposta.json().catch(() => null)) as {
    validationMessages?: { description?: string }[];
  } | null;
  const mensagens = (json?.validationMessages ?? []).map((m) => m.description ?? "erro sem descrição");
  return { ok: mensagens.length === 0, mensagens };
}

export const transporteGa4: TransporteDeConversao<CredencialGa4> = {
  plataforma: "ga4",
  enviar,
};
