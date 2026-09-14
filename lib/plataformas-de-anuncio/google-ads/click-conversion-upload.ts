import { createHash } from "node:crypto";

import { logger } from "@/lib/logger";
import type { ConversaoOffline, ResultadoDeEnvio, TransporteDeConversao } from "../types";
import type { CredencialGoogleAds } from "./credenciais";
import { obterAccessToken } from "./oauth";

/**
 * Google Ads: LEAD/QUALIFIED/PURCHASE sobem via `ClickConversionUpload`
 * (gclid/gbraid/wbraid) quando o touchpoint do lead tem um desses, ou via
 * Enhanced Conversions (email/telefone hasheados) quando não existe —
 * exatamente a regra do item 6 do pedido. `conversionAction` vem do mapa
 * configurável por evento (Google Ads não tem vocabulário fixo como a Meta).
 *
 * ⚠️ A forma exata do payload de Enhanced Conversions sem gclid (o campo
 * `user_identifiers` dentro de `ClickConversion`) não foi validada contra
 * uma conta real — não há como testar chamada de verdade à Google Ads API
 * neste ambiente. Documentado no plano como item de verificação manual com
 * credenciais de sandbox antes de ativar em produção.
 */
const VERSAO_DA_API = "v17";
const TEMPO_LIMITE_MS = 15_000;
const IDADE_MAXIMA_MS = 90 * 24 * 60 * 60 * 1000; // Google Ads aceita até 90 dias de backlog.

function hashGoogle(valor: string): string {
  return createHash("sha256").update(valor.trim().toLowerCase()).digest("hex");
}

function normalizarTelefoneE164(telefone: string): string {
  const digitos = telefone.replace(/\D/g, "");
  return digitos.startsWith("+") ? digitos : `+${digitos}`;
}

async function enviar(
  credencial: CredencialGoogleAds,
  conversao: ConversaoOffline,
): Promise<ResultadoDeEnvio> {
  const idadeMs = Date.now() - conversao.ocorridoEm.getTime();
  if (idadeMs > IDADE_MAXIMA_MS) {
    const dias = Math.floor(idadeMs / (24 * 60 * 60 * 1000));
    return { tipo: "permanente", detalhe: `evento com ${dias} dias — acima do teto do Google Ads (90).` };
  }

  const conversionAction = credencial.conversionActionMap[conversao.evento];
  if (!conversionAction) {
    return {
      tipo: "permanente",
      detalhe: `evento "${conversao.evento}" sem Conversion Action ID configurado.`,
    };
  }

  const cliqueDeOrigem = conversao.gclid ?? conversao.gbraid ?? conversao.wbraid ?? conversao.cliqueDeOrigem;
  const temClique = Boolean(cliqueDeOrigem);
  const temIdentidade = Boolean(conversao.email || conversao.telefone);
  if (!temClique && !temIdentidade) {
    return {
      tipo: "permanente",
      detalhe: "sem gclid/gbraid/wbraid e sem email/telefone para Enhanced Conversions.",
    };
  }

  const tokenResult = await obterAccessToken(credencial);
  if (!tokenResult.ok) {
    return tokenResult.falha === "transitorio"
      ? { tipo: "transitorio", detalhe: tokenResult.detalhe }
      : { tipo: "permanente", detalhe: `oauth recusado: ${tokenResult.detalhe}` };
  }

  const clickConversion: Record<string, unknown> = {
    conversionAction,
    conversionDateTime: formatarDataGoogle(conversao.ocorridoEm),
    ...(conversao.valorCentavos != null
      ? {
          conversionValue: conversao.valorCentavos / 100,
          currencyCode: (conversao.moeda ?? "BRL").toUpperCase(),
        }
      : {}),
  };

  if (temClique) {
    if (conversao.gclid) clickConversion.gclid = conversao.gclid;
    else if (conversao.gbraid) clickConversion.gbraid = conversao.gbraid;
    else if (conversao.wbraid) clickConversion.wbraid = conversao.wbraid;
    else clickConversion.gclid = cliqueDeOrigem;
  } else {
    const userIdentifiers: Record<string, unknown>[] = [];
    if (conversao.email) userIdentifiers.push({ hashedEmail: hashGoogle(conversao.email) });
    if (conversao.telefone) {
      userIdentifiers.push({ hashedPhoneNumber: hashGoogle(normalizarTelefoneE164(conversao.telefone)) });
    }
    clickConversion.userIdentifiers = userIdentifiers;
  }

  const customerId = credencial.customerId.replace(/-/g, "");
  const url = `https://googleads.googleapis.com/${VERSAO_DA_API}/customers/${customerId}:uploadClickConversions`;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${tokenResult.token.accessToken}`,
    "developer-token": credencial.developerToken,
  };
  if (credencial.loginCustomerId) {
    headers["login-customer-id"] = credencial.loginCustomerId.replace(/-/g, "");
  }

  let resposta: Response;
  try {
    resposta = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ conversions: [clickConversion], partialFailure: false }),
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    });
  } catch (erro) {
    return { tipo: "transitorio", detalhe: erro instanceof Error ? erro.message : "falha de rede" };
  }

  if (resposta.ok) return { tipo: "ok" };

  const texto = await resposta.text().catch(() => "");
  logger.warn("[rastreamento.google_ads] envio recusado", {
    status: resposta.status,
    leadId: conversao.leadId,
  });

  if (resposta.status >= 500 || resposta.status === 429) {
    return { tipo: "transitorio", detalhe: `${resposta.status}: ${texto.slice(0, 300)}` };
  }
  return { tipo: "permanente", detalhe: texto.slice(0, 400) };
}

function formatarDataGoogle(data: Date): string {
  // Google Ads API espera "yyyy-MM-dd HH:mm:ss+TZ" — usamos UTC (+00:00) pra
  // não depender do fuso do processo que despacha.
  const iso = data.toISOString(); // 2026-09-11T10:00:00.000Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}+00:00`;
}

export const transporteGoogleAds: TransporteDeConversao<CredencialGoogleAds> = {
  plataforma: "google_ads",
  enviar,
};

export const INTERNOS = { hashGoogle, normalizarTelefoneE164, formatarDataGoogle } as const;
