import type { NodeType } from './graph-schema';

/**
 * O SEGUNDO teto do follow-up: o do MOTOR (#2965).
 *
 * O validador de publish tem o teto dele — `MAX_PATH_STEPS` (30 passos "que o
 * cliente sente", ver `validate-publish.ts`). O relógio tem OUTRO, e até aqui
 * ninguém cruzava as duas pontas: `MAX_STEPS` em `engine.ts` conta TICKS —
 * `steps_taken` sobe a cada passada, tenha o nó chegado ao cliente ou não — e
 * mata a inscrição (`cancel_reason = 'max_steps'`) quando começa um tick com o
 * contador acima do teto. Um fluxo podia, então, passar nos 30 passos sentidos e
 * morrer no meio no motor, sem gravar as últimas caixas nem chegar ao fim.
 *
 * `CUSTO_NO_MOTOR` é o preço em ticks de cada tipo de nó, lido do próprio motor e
 * das invariantes que o CI já roda (`tests/invariants/followup-engine.test.ts`):
 *  - `trigger`, `condition`, `internal_task`, `move_lead`, `edit_lead_tag` e
 *    `end` custam 1 — cada um avança (ou conclui) em um tick;
 *  - `wait` custa 2: um tick arma a espera, outro vence e avança;
 *  - `action` custa 2: o motor ENFILEIRA o turno (`engine.ts`) e a ponte CONCLUI
 *    (`turn-bridge.ts`), cada ponta com o seu `steps_taken + 1`;
 *  - `ai_classify` e `match_reply` custam 2: armam a espera/pedido e resolvem
 *    depois (classificação ou resposta).
 *
 * `Record<NodeType, number>` exaustivo DE PROPÓSITO — mesma doutrina de
 * `CONTA_NO_TETO`: um tipo de nó novo quebra o typecheck até alguém dizer quanto
 * ele custa, em vez de entrar na conta por zero calado.
 *
 * O custo é um PISO: rechecks de turno lento também gastam tick
 * (`node-handlers.ts` devolve `recheck`), e só somam.
 */
export const CUSTO_NO_MOTOR: Record<NodeType, number> = {
  // Um tick para atravessar (ou concluir).
  trigger: 1,
  condition: 1,
  internal_task: 1,
  move_lead: 1,
  edit_lead_tag: 1,
  end: 1,
  // Dois ticks: arma e fecha.
  wait: 2,
  action: 2,
  ai_classify: 2,
  match_reply: 2,
  // Roteiro de atendimento: outro motor (o do turno, não o do relógio) — aqui é
  // passagem, um tick.
  collect: 1,
  skill: 1,
  // `repeat` é CICLO: quantas voltas o lead faz na resposta decide o custo, e por
  // isso o caminho por ele não é uma soma linear. Vale 1 tick por passagem, e é
  // este preço que a publicação multiplica pelas voltas que o `repeat` permite
  // (`custoNoMotorDoFluxo`, #2977).
  repeat: 1,
};

/**
 * O teto de ticks do motor. É o MESMO número de `MAX_STEPS` em `engine.ts` — que
 * passou a importá-lo daqui, para as duas pontas não poderem divergir: o motor
 * marca a inscrição como morta quando COMEÇA um tick com `steps_taken` acima
 * disto, então uma cadência só termina se couber no orçamento.
 */
export const TETO_DE_PASSOS_DO_MOTOR = 80;
