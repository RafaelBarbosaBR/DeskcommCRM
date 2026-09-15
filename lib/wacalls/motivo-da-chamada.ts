/**
 * `voice_calls.end_reason` é vocabulário do SERVIDOR (aberto, sem CHECK — ver
 * o cabeçalho da migration 0247: quem grava é o bridge lendo o evento do
 * WaCalls, e o terceiro pode acrescentar motivo novo sem migration nossa).
 * Esta função só traduz o que já se conhece; motivo desconhecido cai num
 * rótulo honesto em vez de mostrar o código cru na tela.
 */
export function motivoDaChamada(reason: string | null): string {
  switch (reason) {
    case "accepted":
      return "Atendida";
    case "declined":
      return "Recusada";
    case "timeout":
      return "Não atendida";
    case "busy":
      return "Ocupado";
    case "network_error":
      return "Falha de conexão";
    case "hangup_local":
      return "Encerrada por quem atende";
    case "hangup_remote":
      return "Encerrada pelo cliente";
    case null:
      return "Em andamento";
    default:
      return "Encerrada";
  }
}
