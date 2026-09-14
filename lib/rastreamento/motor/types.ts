/**
 * O vocabulário AGNÓSTICO do motor de rastreamento: só estes 5 eventos.
 *
 * Nenhum código fora de `lib/plataformas-de-anuncio/` (os adapters) pode
 * conhecer nome de evento de plataforma (Purchase/generate_lead/conversion).
 * O domínio do CRM (pipeline, kanban, webhooks) só produz um destes 5 —
 * o despacho pra cada provider é responsabilidade do adapter, não de quem
 * dispara o evento.
 */
export type TipoDeEventoInterno =
  | "PAGE_VIEW"
  | "CONTACT"
  | "LEAD"
  | "QUALIFIED"
  | "PURCHASE";

export const TIPOS_DE_EVENTO_INTERNO: readonly TipoDeEventoInterno[] = [
  "PAGE_VIEW",
  "CONTACT",
  "LEAD",
  "QUALIFIED",
  "PURCHASE",
] as const;
