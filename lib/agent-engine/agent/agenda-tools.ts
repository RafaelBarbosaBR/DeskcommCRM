/**
 * "Este agente mexe com agenda?" — uma pergunta, um lugar.
 *
 * Antes só `crm_book_appointment` respondia isso (em três sítios: o bloco de
 * sistema residente e o `agenda.active` do gate em `inbound-turn.ts`, e o
 * `agenda.active` da prévia em `preview.ts`). Um agente configurado só para
 * CONSULTAR (`crm_find_free_slots`/`crm_list_appointments`, sem nenhuma tool
 * que cria ou muda reserva) nunca armava a trava — e o modelo podia alucinar
 * "confirmado" sem NENHUMA rede pegando, porque a pergunta certa nunca foi
 * "ele marca?" e sim "ele mexe com agenda de algum jeito?".
 *
 * Fica em módulo próprio (e não dentro de `inbound-turn.ts`) porque
 * `preview.ts` também precisa da resposta, e `preview.ts` já importa TIPOS de
 * `inbound-turn.ts` — importar a FUNÇÃO de lá fecharia um ciclo em runtime.
 */
export const AGENDA_TOOL_IDS = [
  'crm_find_free_slots',
  'crm_list_appointments',
  'crm_book_appointment',
  'crm_reschedule_appointment',
  'crm_cancel_appointment',
] as const;

export function agendaAtiva(toolIds: readonly string[]): boolean {
  return AGENDA_TOOL_IDS.some((id) => toolIds.includes(id));
}
