/**
 * DOIS EIXOS DE DESLIGADO, sempre combinados com `&&`, nunca um substituindo o
 * outro:
 *
 *   1. A INSTALAÇÃO oferece o recurso — decisão de quem administra a VPS,
 *      configurando `WACALLS_API_BASE_URL`/`WACALLS_API_TOKEN` no `.env`.
 *   2. A ORGANIZAÇÃO aceitou o risco — decisão de negócio de um admin do
 *      tenant, gravada em `org_voice_calls.enabled`.
 *
 * Uma organização não pode ligar o que a instalação não oferece (o botão nem
 * aparece — não é gate cosmético, é impossibilidade real: não há sessão
 * WaCalls para parear). E a instalação oferecer não liga nada sozinha: é
 * capacidade NOVA, sem passado a preservar — ao contrário das camadas de
 * guardrail (`lib/agent-engine/guardrails/camadas-da-org.ts`), que migravam
 * instalação existente e por isso caem no ambiente quando a org não escolheu.
 * Aqui não escolher é, e continua sendo, desligado.
 */
import { getWacallsClient } from "@/lib/wacalls/client";

/** A VPS tem o serviço WaCalls configurado. */
export function instalacaoOfereceVoz(): boolean {
  return getWacallsClient() !== null;
}

export type EstadoDaVoz =
  | "instalacao_nao_oferece"
  | "organizacao_nao_aceitou"
  | "ligado";

/** Função pura — testável sem env nem banco, recebendo os dois fatos já resolvidos. */
export function estadoDaVoz(instalacaoOferece: boolean, organizacaoAceitou: boolean): EstadoDaVoz {
  if (!instalacaoOferece) return "instalacao_nao_oferece";
  if (!organizacaoAceitou) return "organizacao_nao_aceitou";
  return "ligado";
}

/** Os dois eixos, resolvidos: só `true` quando AMBOS estão de acordo. */
export function chamadaDeVozLigada(organizacaoAceitou: boolean): boolean {
  return instalacaoOfereceVoz() && organizacaoAceitou === true;
}
