/**
 * "Organizar" o canvas do editor de follow-up — empilha o fluxo conectado de
 * cima para baixo.
 *
 * Sem `dagre`/`elkjs` de propósito: um layout Sugiyama genérico resolve um
 * problema que este grafo não tem — fluxos de follow-up são quase-lineares
 * (gatilho → alguns nós → fim, com poucos ramos de condição), então BFS por
 * profundidade a partir do gatilho já produz o resultado que a pessoa espera,
 * sem trazer uma dependência pesada pra decidir onde desenhar meia dúzia de
 * caixas.
 *
 * Camada = distância (em arestas) até o nó mais próximo sem entrada — na
 * prática, o nó `trigger`. Cada camada vira uma LINHA (mesmo Y), empilhada de
 * cima para baixo; dentro da linha, a ordem é a mesma que a pessoa já tinha
 * (por X atual) — reorganizar não deveria trocar a ordem que alguém escolheu
 * entre irmãos, só realinhar.
 */

export interface NoParaOrganizar {
  id: string;
  position: { x: number; y: number };
}

export interface ArestaParaOrganizar {
  source: string;
  target: string;
}

const LARGURA_ENTRE_NOS = 260;
const ALTURA_ENTRE_CAMADAS = 160;

export function organizarFluxo<T extends NoParaOrganizar>(
  nodes: readonly T[],
  edges: readonly ArestaParaOrganizar[],
): T[] {
  if (nodes.length === 0) return [...nodes];

  const saidas = new Map<string, string[]>();
  const temEntrada = new Set<string>();
  for (const e of edges) {
    saidas.set(e.source, [...(saidas.get(e.source) ?? []), e.target]);
    temEntrada.add(e.target);
  }

  // Raiz = sem aresta de entrada E COM alguma saída (o `trigger`, normalmente)
  // — o segundo requisito é o que separa uma raiz de verdade de um nó
  // ilha (nenhuma aresta em nenhum sentido), que também não tem entrada mas
  // não lidera coisa nenhuma: sem ele, a ilha entrava na BFS como se fosse
  // raiz e ganhava profundidade 0 em vez de cair no "nunca alcançado" lá
  // embaixo. Um grafo sem nenhuma raiz identificável (todo nó tem entrada —
  // só acontece com um ciclo cobrindo tudo, estado que o publish já recusa
  // antes de chegar aqui) cai no primeiro nó da lista em vez de travar sem
  // desenhar nada.
  const raizes = nodes.filter((n) => !temEntrada.has(n.id) && saidas.has(n.id));
  const partida = raizes.length > 0 ? raizes : nodes.slice(0, 1);

  const profundidade = new Map<string, number>();
  const fila: string[] = [];
  for (const r of partida) {
    profundidade.set(r.id, 0);
    fila.push(r.id);
  }
  let cursor = 0;
  while (cursor < fila.length) {
    const atualId = fila[cursor++]!;
    const nivel = profundidade.get(atualId)!;
    for (const proximoId of saidas.get(atualId) ?? []) {
      // Já visitado: não reabre camada mais rasa, e o `continue` é o que
      // impede um ciclo (`repeat` volta pro nó anterior) de girar para
      // sempre.
      if (profundidade.has(proximoId)) continue;
      profundidade.set(proximoId, nivel + 1);
      fila.push(proximoId);
    }
  }

  // Nó nunca alcançado a partir de nenhuma raiz (ilha desconexa do resto do
  // grafo) entra na última camada — não pode ficar sem posição, e não há
  // camada mais certa para ele do que "depois de tudo que se sabe alcançar".
  let profundidadeMaxima = 0;
  for (const p of profundidade.values()) profundidadeMaxima = Math.max(profundidadeMaxima, p);
  for (const n of nodes) {
    if (!profundidade.has(n.id)) profundidade.set(n.id, profundidadeMaxima + 1);
  }

  const porCamada = new Map<number, T[]>();
  for (const n of nodes) {
    const d = profundidade.get(n.id)!;
    porCamada.set(d, [...(porCamada.get(d) ?? []), n]);
  }

  const posicaoPorId = new Map<string, { x: number; y: number }>();
  for (const [camada, nosDaCamada] of [...porCamada.entries()].sort((a, b) => a[0] - b[0])) {
    const ordenados = [...nosDaCamada].sort((a, b) => a.position.x - b.position.x);
    ordenados.forEach((n, indice) => {
      posicaoPorId.set(n.id, { x: indice * LARGURA_ENTRE_NOS, y: camada * ALTURA_ENTRE_CAMADAS });
    });
  }

  return nodes.map((n) => ({ ...n, position: posicaoPorId.get(n.id) ?? n.position }));
}
