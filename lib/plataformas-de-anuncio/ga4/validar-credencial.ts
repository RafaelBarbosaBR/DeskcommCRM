/**
 * Testa measurement_id+api_secret contra o endpoint de DEBUG do Measurement
 * Protocol (o único caminho do GA4 que devolve `validationMessages` reais —
 * o de produção é fire-and-forget, sempre 204). Item 7 do pedido: nunca
 * simula sucesso sem resposta real.
 */
const ENDPOINT_DEBUG = "https://www.google-analytics.com/debug/mp/collect";

export type ResultadoDeValidacaoGa4 = { ok: true } | { ok: false; motivo: string };

export async function validarCredencialGa4(
  measurementId: string,
  apiSecret: string,
): Promise<ResultadoDeValidacaoGa4> {
  const url = `${ENDPOINT_DEBUG}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;
  const corpoDeTeste = {
    // Opaco para o GA4 — não precisa (e não deve) nomear o produto: é só o
    // `client_id` de um evento de teste que nunca aparece em relatório nenhum.
    client_id: "crm-teste-de-conexao",
    events: [{ name: "generate_lead", params: { transaction_id: "teste-de-conexao" } }],
  };

  let resposta: Response;
  try {
    resposta = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(corpoDeTeste),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (erro) {
    return { ok: false, motivo: erro instanceof Error ? erro.message : "falha de rede" };
  }

  if (!resposta.ok) return { ok: false, motivo: `GA4 devolveu status ${resposta.status}` };

  const json = (await resposta.json().catch(() => null)) as {
    validationMessages?: { description?: string }[];
  } | null;
  const mensagens = json?.validationMessages ?? [];
  if (mensagens.length > 0) {
    return { ok: false, motivo: mensagens.map((m) => m.description ?? "erro").join("; ") };
  }
  return { ok: true };
}
