import { logger } from "@/lib/logger";
import type { CredencialGoogleAds } from "./credenciais";

/**
 * Troca refresh_token por access_token de curta duração. Sem cache
 * persistente de propósito: o volume de despacho deste motor é por evento
 * (não por página), então um refresh a cada chamada é barato e evita gerir
 * expiração entre invocações de serverless function (cada cold start
 * perderia um cache em memória mesmo).
 */
export interface TokenDeAcesso {
  accessToken: string;
}

export type FalhaDeOauth = "credencial_invalida" | "transitorio";

export async function obterAccessToken(
  credencial: Pick<CredencialGoogleAds, "clientId" | "clientSecret" | "refreshToken">,
): Promise<{ ok: true; token: TokenDeAcesso } | { ok: false; falha: FalhaDeOauth; detalhe: string }> {
  let resposta: Response;
  try {
    resposta = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: credencial.clientId,
        client_secret: credencial.clientSecret,
        refresh_token: credencial.refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (erro) {
    return {
      ok: false,
      falha: "transitorio",
      detalhe: erro instanceof Error ? erro.message : "falha de rede",
    };
  }

  if (!resposta.ok) {
    const texto = await resposta.text().catch(() => "");
    logger.warn("[rastreamento.google_ads.oauth] refresh recusado", {
      status: resposta.status,
    });
    return {
      ok: false,
      falha: resposta.status >= 500 ? "transitorio" : "credencial_invalida",
      detalhe: texto.slice(0, 300),
    };
  }

  const json = (await resposta.json()) as { access_token?: string };
  if (!json.access_token) {
    return { ok: false, falha: "credencial_invalida", detalhe: "resposta sem access_token" };
  }
  return { ok: true, token: { accessToken: json.access_token } };
}
