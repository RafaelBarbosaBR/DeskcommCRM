/** O que uma troca proporcional ocupa na linha; tudo `null` = sem troca em curso. */
export const SEM_TROCA = {
  troca_id: null, plano_troca_pendente_id: null, troca_valor_cents: null, troca_status: null,
  troca_pagamento_ref: null, troca_pagamento_url: null, troca_reserva_ate: null,
} as const;

/**
 * Abaixo disto o provedor recusa a cobrança avulsa (Asaas: R$ 5,00; Stripe BRL:
 * R$ 0,50 — vale o maior). Fonte: a documentação dos dois, não medido aqui. Um
 * ajuste menor vira 0, e o upgrade cai no agendamento, como o de ajuste zero.
 */
export const AJUSTE_MINIMO_CENTS = 500;

/**
 * Calcula o ajuste de um upgrade pelo tempo restante do período já pago.
 * O período vem do provedor (em instantes), e o valor fica em centavos BRL.
 * É a mesma conta na tela (estimativa) e em `troca.ts` (cobrança).
 */
export function calcularAjusteProporcional(input: {
  precoAtualCents: number;
  precoNovoCents: number;
  periodoPagoDesde: Date | null;
  proximoVencimento: Date | null;
  agora: Date;
}): number | null {
  const { precoAtualCents, precoNovoCents, periodoPagoDesde, proximoVencimento, agora } = input;
  if (precoNovoCents <= precoAtualCents) return 0;
  if (!periodoPagoDesde || !proximoVencimento) return null;
  const inicio = periodoPagoDesde.getTime();
  const fim = proximoVencimento.getTime();
  const agoraMs = agora.getTime();
  if (![inicio, fim, agoraMs].every(Number.isFinite) || fim <= inicio || fim <= agoraMs) return 0;
  const restante = Math.min(1, Math.max(0, (fim - agoraMs) / (fim - inicio)));
  const valor = Math.round((precoNovoCents - precoAtualCents) * restante);
  return valor < AJUSTE_MINIMO_CENTS ? 0 : valor;
}
