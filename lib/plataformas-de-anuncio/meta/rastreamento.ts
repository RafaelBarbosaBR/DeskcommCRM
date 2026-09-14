import { createHash } from "node:crypto";

import { logger } from "@/lib/logger";
import type {
  ConversaoOffline,
  ResultadoDeEnvio,
  TransporteDeConversao,
} from "../types";
import type { CredencialMetaRastreamento } from "./credenciais-rastreamento";

/**
 * Transporte de Meta pro motor de rastreamento first-party — irmão de
 * `./conversions.ts` (o do pipeline legado Purchase-on-won via CTWA),
 * deliberadamente um arquivo à parte: os 5 eventos internos, `action_source`
 * variável por origem (aqui sempre "website" — os 5 eventos deste motor
 * nascem de uma página rastreada, nunca de uma conversa de WhatsApp) e
 * Advanced Matching com `fbc`/email/external_id além de telefone.
 *
 * Mesma classificação de erro 4xx-vs-5xx-vs-throttle do transporte legado —
 * a física da falha (Meta) não mudou, só o payload.
 */
const VERSAO_DA_API = "v22.0";
const IDADE_MAXIMA_MS = 7 * 24 * 60 * 60 * 1000;
const TEMPO_LIMITE_MS = 10_000;

function hash(valor: string): string {
  return createHash("sha256").update(valor.trim().toLowerCase()).digest("hex");
}

function classifica4xx(codigo: number | null, mensagem: string): ResultadoDeEnvio {
  if (codigo === 613 || codigo === 80004) {
    return { tipo: "transitorio", detalhe: `limite de chamadas (${codigo}): ${mensagem}` };
  }
  return { tipo: "permanente", detalhe: mensagem };
}

async function enviar(
  credencial: CredencialMetaRastreamento,
  conversao: ConversaoOffline,
): Promise<ResultadoDeEnvio> {
  const idadeMs = Date.now() - conversao.ocorridoEm.getTime();
  if (idadeMs > IDADE_MAXIMA_MS) {
    const dias = Math.floor(idadeMs / (24 * 60 * 60 * 1000));
    return {
      tipo: "permanente",
      detalhe: `evento com ${dias} dias — a plataforma recusa acima de 7.`,
    };
  }

  // Advanced Matching: só entra o que REALMENTE foi capturado — nunca
  // fabricado (item 1 do pedido). `external_id` é o visitor_id, hasheado
  // pela mesma regra da Meta pra todo identificador em Advanced Matching.
  const userData: Record<string, unknown> = {};
  if (conversao.telefone) userData.ph = [hash(conversao.telefone)];
  if (conversao.email) userData.em = [hash(conversao.email)];
  if (conversao.clientId) userData.external_id = [hash(conversao.clientId)];
  if (conversao.fbc) userData.fbc = conversao.fbc;
  if (conversao.cliqueDeOrigem && !conversao.fbc) {
    // fbclid cru sem fbc calculado (não deveria acontecer — o tracker.js
    // sempre calcula fbc a partir do fbclid — mas não custa mandar como
    // sinal extra se algum dia existir).
    userData.fbc = conversao.cliqueDeOrigem;
  }

  const corpo: Record<string, unknown> = {
    data: [
      {
        event_name: conversao.evento,
        event_time: Math.floor(conversao.ocorridoEm.getTime() / 1000),
        event_id: conversao.eventoId,
        action_source: conversao.actionSource ?? "website",
        user_data: userData,
        ...(conversao.valorCentavos != null
          ? {
              custom_data: {
                value: conversao.valorCentavos / 100,
                currency: (conversao.moeda ?? "BRL").toUpperCase(),
              },
            }
          : {}),
      },
    ],
  };
  if (credencial.testEventCode) corpo.test_event_code = credencial.testEventCode;

  const url =
    `https://graph.facebook.com/${VERSAO_DA_API}/` +
    `${encodeURIComponent(credencial.pixelId)}/events`;

  let resposta: Response;
  try {
    resposta = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credencial.accessToken}`,
      },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    });
  } catch (erro) {
    return {
      tipo: "transitorio",
      detalhe: erro instanceof Error ? erro.message : "falha de rede",
    };
  }

  if (resposta.ok) return { tipo: "ok" };

  const texto = await resposta.text().catch(() => "");
  let codigo: number | null = null;
  let mensagem = texto.slice(0, 400);
  try {
    const json = JSON.parse(texto) as { error?: { code?: number; message?: string } };
    if (typeof json.error?.code === "number") codigo = json.error.code;
    if (json.error?.message) mensagem = json.error.message;
  } catch {
    // corpo não-JSON de erro = gateway/WAF no meio do caminho.
  }

  logger.warn("[rastreamento.meta] envio recusado", {
    status: resposta.status,
    codigo,
    leadId: conversao.leadId,
  });

  if (resposta.status >= 500) {
    return { tipo: "transitorio", detalhe: `${resposta.status}: ${mensagem}` };
  }
  return classifica4xx(codigo, mensagem);
}

export const transporteMetaRastreamento: TransporteDeConversao<CredencialMetaRastreamento> = {
  plataforma: "meta_ads",
  enviar,
};

export const INTERNOS_RASTREAMENTO = { hash, classifica4xx, IDADE_MAXIMA_MS } as const;
