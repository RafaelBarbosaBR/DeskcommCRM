/**
 * O visto azul (#2981): depois de todo envio aceito, o adapter do WAHA manda
 * `POST /api/sendSeen` — sem esperar, então ele chega ao receptor DEPOIS da
 * mensagem e às vezes depois da asserção. Não é mensagem: um receptor de teste
 * que conta envios responde e ignora este pedido, senão "saiu exatamente uma"
 * vira "saíram duas" (ou passa por sorte de corrida).
 */
export const ehVistoAzul = (url: string | undefined): boolean =>
  (url ?? "").split("?")[0] === "/api/sendSeen";
