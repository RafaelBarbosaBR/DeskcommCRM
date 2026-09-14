/**
 * Vocabulário dos compromissos leves do lead (item 7 do pedido do dossiê).
 * Tabela própria (`crm_lead_appointments`) — não é `calendar_appointments`
 * (o motor tipo Calendly, que exige disponibilidade publicada e não reabre
 * cancelado). Ver `supabase/migrations/..._0239_compromissos_do_lead.sql`.
 */
export const TIPOS_DE_COMPROMISSO = ["proximo_contato", "reuniao", "ligacao", "outro"] as const;
export type TipoDeCompromisso = (typeof TIPOS_DE_COMPROMISSO)[number];

export const ROTULO_DO_TIPO: Record<TipoDeCompromisso, string> = {
  proximo_contato: "Próximo contato",
  reuniao: "Reunião",
  ligacao: "Ligação",
  outro: "Outro",
};

export const STATUS_DE_COMPROMISSO = ["pending", "completed", "cancelled"] as const;
export type StatusDeCompromisso = (typeof STATUS_DE_COMPROMISSO)[number];

export const ROTULO_DO_STATUS: Record<StatusDeCompromisso, string> = {
  pending: "Pendente",
  completed: "Concluído",
  cancelled: "Cancelado",
};
