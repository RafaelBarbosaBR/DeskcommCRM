/**
 * Testa pixel_id+access_token contra a Graph API de verdade antes de gravar
 * (item 7 do pedido: nunca simula sucesso sem resposta real). Mesmo padrão
 * de `lib/channels/meta/validate-credentials.ts` (o canal oficial de
 * WhatsApp) — chamada síncrona dentro do próprio salvamento, não um botão de
 * "ping" separado.
 */
export type ResultadoDeValidacaoMeta = { ok: true } | { ok: false; motivo: string };

export async function validarCredencialMeta(
  pixelId: string,
  accessToken: string,
): Promise<ResultadoDeValidacaoMeta> {
  const url = `https://graph.facebook.com/v22.0/${encodeURIComponent(pixelId)}?fields=id&access_token=${encodeURIComponent(accessToken)}`;
  let resposta: Response;
  try {
    resposta = await fetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
  } catch (erro) {
    return { ok: false, motivo: erro instanceof Error ? erro.message : "falha de rede" };
  }
  if (resposta.ok) return { ok: true };
  const texto = await resposta.text().catch(() => "");
  return { ok: false, motivo: texto.slice(0, 300) || `status ${resposta.status}` };
}
