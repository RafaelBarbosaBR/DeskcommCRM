import { obterAccessToken } from "./oauth";

/**
 * Testa developer_token+client_id/secret+refresh_token contra a Google Ads
 * API de verdade: troca o refresh token (valida client_id/secret/refresh
 * juntos) e chama `listAccessibleCustomers` (valida o developer_token — ele
 * vai no header, e a API recusa developer_token inválido mesmo pra esse
 * endpoint que não exige customer_id nenhum). Item 7 do pedido.
 */
export type ResultadoDeValidacaoGoogleAds = { ok: true } | { ok: false; motivo: string };

export async function validarCredencialGoogleAds(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  developerToken: string;
}): Promise<ResultadoDeValidacaoGoogleAds> {
  const tokenResult = await obterAccessToken(input);
  if (!tokenResult.ok) return { ok: false, motivo: `oauth: ${tokenResult.detalhe}` };

  let resposta: Response;
  try {
    resposta = await fetch("https://googleads.googleapis.com/v17/customers:listAccessibleCustomers", {
      method: "GET",
      headers: {
        authorization: `Bearer ${tokenResult.token.accessToken}`,
        "developer-token": input.developerToken,
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (erro) {
    return { ok: false, motivo: erro instanceof Error ? erro.message : "falha de rede" };
  }

  if (resposta.ok) return { ok: true };
  const texto = await resposta.text().catch(() => "");
  return { ok: false, motivo: texto.slice(0, 300) || `status ${resposta.status}` };
}
