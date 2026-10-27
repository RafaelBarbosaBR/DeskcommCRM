/**
 * Detecção de DUPLICATA PRÓXIMA de conteúdo — puro, sem I/O, sem dependência.
 *
 * ## Por que existe (medido ao vivo em produção, 2026-10)
 *
 * Uma única pergunta do paciente recebeu 4 respostas do agente. Três vieram do
 * caminho de recuperação do "turno mudo": o primeiro `agent_turn` terminou sem
 * candidato enviável, a correção do turno mudo re-perguntou ao modelo, e o modelo
 * chamou `send_message` três vezes com corpos quase idênticos — cada um passou
 * pelas cadeias de guardrails e virou uma bolha separada no WhatsApp. A quarta
 * veio de um follow-up de promessa agendado que re-respondeu a mesma pergunta.
 *
 * O contrato do produto é UMA resposta adequada e completa por turno. Repetição
 * imediata da mesma ideia é redundância, não informação nova. Este módulo é a régua
 * pura que decide se um candidato é repetição do que já saiu — onde "já saiu" é
 * decidido por quem chama (turno em memória ou histórico recente via banco).
 *
 * ## Escopo deliberado (não suprimir resposta legítima)
 *
 * A comparação é CONTEÚDO, não tópico. Dois textos que falam do mesmo exame com
 * redação diferente passam (semelhança baixa); o mesmo texto (ou quase) é
 * redundância. A janela temporal é responsabilidade de quem chama: o turno guarda
 * o que saiu desde a última fala do cliente (no próprio turno e no banco). Isso
 * mantém "não suprimir resposta futura legítima sobre o mesmo tópico" fora da
 * régua — a régua só vê similaridade de texto, nunca assunto.
 *
 * ## Forma
 *
 * Normalização (NFC + zero-width + colapso de espaço + caixa) seguida do
 * coeficiente de Dice sobre bigramas de código-fonte. Bigramas de `Array.from`
 * iteram por ponto de código, então Devanagari (e pares substitutos) não quebram.
 * Igualdade normalizada é duplicata por construção; semelhança >= limiar é
 * duplicata próxima. Padrão de limiar alto (0.9): só quase-idênticos suprimem,
 * para preservar mensagens genuinamente distintas.
 *
 * ## Exceção de informação nova (#2996, item 3)
 *
 * Perto do limiar, NEM todo quase-idêntico é repetição: preço/hora mudado
 * ("R$ 1.250" → "R$ 1.350", "9h" → "10h") ou negação trocada ("Sim, fazemos
 * entrega" → "Não, fazemos entrega") é INFORMAÇÃO NOVA e passa
 * (`mudaInformacao`). Qualquer número mudado passa. Igualdade normalizada
 * continua suprimindo incondicionalmente.
 */

/** Zero-width e BOM — invisíveis, mas quebram a igualdade ingênua. */
const INVISIVEIS = /[\u200B\u200C\u200D\uFEFF]/g;

/**
 * Normaliza um corpo para comparação: NFC, remove invisíveis, colapsa qualquer
 * sequência de espaço em um espaço só, trim, caixa baixa. Devanagari não tem
 * caixa (toLowerCase é no-op); latin/pt colapsa variações de capitalização.
 */
export function normalizarParaComparacao(body: string): string {
  return body
    .normalize('NFC')
    .replace(INVISIVEIS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Multicontagem de bigramas de código-fonte (Array.from respeita pontos de código). */
function bigramas(s: string): Map<string, number> {
  const chars = Array.from(s);
  const m = new Map<string, number>();
  for (let i = 0; i < chars.length - 1; i++) {
    const g = chars[i]! + chars[i + 1]!;
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/**
 * Coeficiente de Dice sobre bigramas: 2 * interseção / (|A| + |B|), com
 * interseção contada por multicontagem (min por bigrama). 1 = idêntico.
 * Strings com menos de 2 caracteres só são iguais por igualdade exata.
 */
export function similaridadeDice(a: string, b: string): number {
  if (a === b) return 1;
  const charsA = Array.from(a);
  const charsB = Array.from(b);
  if (charsA.length < 2 || charsB.length < 2) return 0;
  const A = bigramas(a);
  const B = bigramas(b);
  let interseccao = 0;
  for (const [g, ca] of A) {
    const cb = B.get(g);
    if (cb !== undefined) interseccao += Math.min(ca, cb);
  }
  let totalA = 0;
  for (const v of A.values()) totalA += v;
  let totalB = 0;
  for (const v of B.values()) totalB += v;
  return (2 * interseccao) / (totalA + totalB);
}

/** Limiar padrão: quase-idêntico. Abaixo disso é redação distinta — passa. */
export const LIMIAR_DUPLICADO_PROXIMO = 0.9;

/**
 * Negação em PT-BR (após normalização: caixa baixa, espaços colapsados).
 * Lista fechada e curta de propósito: "não/nao", "nem", "nunca", "jamais" —
 * palavras que INVERTEM o sentido. Não inclui atenuantes ("sem", "livre de")
 * porque suprimir com eles erraria para o lado de suprimir informação nova.
 */
const NEGACOES = /\bn[ãa]o\b|\bnem\b|\bnunca\b|\bjamais\b/;

/** Os números do texto, na ordem em que aparecem ("às 9:00, R$ 1.250" → "9 00 1 250"). */
function numeros(texto: string): string {
  return (texto.match(/\d+/g) ?? []).join(' ');
}

/**
 * `true` quando a diferença entre os dois textos carrega INFORMAÇÃO NOVA e não
 * é mais repetição — a régua não suprime (revisão do #2996, item 3):
 *
 *  1. NEGAÇÃO adicionada, removida ou trocada ("Sim, fazemos entrega" →
 *     "Não, fazemos entrega"; "pagamento foi confirmado" → "não foi") — o
 *     sentido invertido é a informação;
 *  2. QUALQUER número mudado: preço ("R$ 25" → "R$ 35"), data ("dia 15" →
 *     "dia 16"), hora ("9:00" → "10:00"), pedido, telefone, vagas. Separar
 *     "valor" de "contador" pela forma do número errava nos dois sentidos: um
 *     número solto também é preço, data e hora. Repetição sem número novo segue
 *     suprimindo.
 */
export function mudaInformacao(candidato: string, jaEnviado: string): boolean {
  const temNegC = NEGACOES.test(candidato);
  const temNegE = NEGACOES.test(jaEnviado);
  if (temNegC !== temNegE) return true;
  return numeros(candidato) !== numeros(jaEnviado);
}

/**
 * `true` quando `candidato` é duplicata (igual normalizada) ou duplicata próxima
 * (semelhança >= `limiar`) de `jaEnviado`. Comparação em branco nunca suprime.
 * Iguais normalizadas suprimem SEM passar pelas exceções — reentrada idêntica
 * é o caso mais forte de repetição; as exceções valem só perto do limiar.
 */
export function ehDuplicadoOuProximo(
  candidato: string,
  jaEnviado: string,
  limiar: number = LIMIAR_DUPLICADO_PROXIMO,
): boolean {
  const c = normalizarParaComparacao(candidato);
  const e = normalizarParaComparacao(jaEnviado);
  if (c === e) return c.length > 0;
  if (c.length < 2 || e.length < 2) return false;
  if (similaridadeDice(c, e) < limiar) return false;
  return !mudaInformacao(c, e);
}

/**
 * Primeiro corpo de `jaEnviados` do qual `candidato` é duplicata (ou `null`).
 * Ordem = ordem de envio; devolver o primeiro mantém a PRIMEIRA resposta e
 * suprime a repetição — é o que "retendo a primeira resposta adequada" pede.
 */
export function encontraDuplicado(
  candidato: string,
  jaEnviados: readonly string[],
  limiar: number = LIMIAR_DUPLICADO_PROXIMO,
): string | null {
  for (const previo of jaEnviados) {
    if (ehDuplicadoOuProximo(candidato, previo, limiar)) return previo;
  }
  return null;
}

/**
 * A trava de envio do turno — memória durável + reserva EM VOO (#2996, item 6).
 *
 * O SDK executa as tool calls de um MESMO passo em paralelo: sem a reserva,
 * três `send_message` quase idênticos passariam todos pela checagem antes de
 * qualquer envio terminar de registrar. A disciplina é:
 *
 *  - `checar(candidato)` — compara contra `aceitos ∪ emVoo` (não se auto-
 *    suprime: o candidato ainda não foi reservado quando é checado);
 *  - `reservar(candidato)` — síncrono, imediatamente após o `checar` vazio e
 *    antes de QUALQUER await; a partir daqui a candidata vale como "em envio"
 *    para as chamadas paralelas;
 *  - `promover(candidato)` — envio aceito (sent/already_sent/queued): sai de
 *    `emVoo` e entra em `aceitos` — transição exatamente uma vez;
 *  - `liberar(candidato)` — veto, falha ou exceção: só sai de `emVoo`; nada
 *    é promovido, então a próxima tentativa legítima não fica bloqueada por
 *    uma reserva órfã.
 *
 * Puro e síncrono por construção — sem lock, sem tempo: o fechamento da
 * corrida vem do check-then-reserve ser atômico no event loop (uma chamada
 * reserva na mesma tick em que passa, antes de ceder o event loop).
 */
export interface TravaDeDuplicata {
  checar(candidato: string): string | null;
  reservar(candidato: string): void;
  promover(candidato: string): void;
  liberar(candidato: string): void;
  /** Semeia a memória durável com o histórico do banco (janela desde a última inbound). */
  semear(corpos: readonly string[]): void;
  aceitos(): readonly string[];
  emVoo(): readonly string[];
}

export function criarTravaDeDuplicata(
  limiar: number = LIMIAR_DUPLICADO_PROXIMO,
): TravaDeDuplicata {
  const aceitos: string[] = [];
  const emVoo: string[] = [];
  return {
    checar: (candidato) => encontraDuplicado(candidato, [...aceitos, ...emVoo], limiar),
    reservar: (candidato) => {
      emVoo.push(candidato);
    },
    promover: (candidato) => {
      const i = emVoo.indexOf(candidato);
      if (i >= 0) emVoo.splice(i, 1);
      if (!aceitos.includes(candidato)) aceitos.push(candidato);
    },
    liberar: (candidato) => {
      const i = emVoo.indexOf(candidato);
      if (i >= 0) emVoo.splice(i, 1);
    },
    semear: (corpos) => {
      for (const c of corpos) if (!aceitos.includes(c)) aceitos.push(c);
    },
    aceitos: () => [...aceitos],
    emVoo: () => [...emVoo],
  };
}
