/**
 * "ORGANIZAR" EMPILHA DE CIMA PARA BAIXO, SEM SE PERDER EM CICLO.
 *
 * `repeat` (um nó que volta pro anterior) é parte normal do vocabulário deste
 * editor — um BFS ingênuo que não marca visitado gira para sempre nesse caso.
 * O que se prende: camada = distância do gatilho, empilhada em Y; ordem
 * dentro da camada preserva o X que a pessoa já tinha; nó desconexo não
 * desaparece; e a função nunca reordena o ARRAY de entrada, só a posição.
 */
import { describe, expect, it } from "vitest";

import { organizarFluxo, type ArestaParaOrganizar, type NoParaOrganizar } from "./auto-layout";

function no(id: string, x: number, y = 999): NoParaOrganizar & { id: string } {
  return { id, position: { x, y } };
}
function aresta(source: string, target: string): ArestaParaOrganizar {
  return { source, target };
}

describe("organizarFluxo", () => {
  it("cadeia linear: cada nó numa camada própria, empilhada em Y crescente", () => {
    const nodes = [no("trigger", 0), no("wait", 0), no("end", 0)];
    const edges = [aresta("trigger", "wait"), aresta("wait", "end")];

    const r = organizarFluxo(nodes, edges);

    const porId = new Map(r.map((n) => [n.id, n.position]));
    expect(porId.get("trigger")!.y).toBeLessThan(porId.get("wait")!.y);
    expect(porId.get("wait")!.y).toBeLessThan(porId.get("end")!.y);
  });

  it("ramo (trigger → a, b): os dois na MESMA camada (mesmo Y), ordenados pelo X que já tinham", () => {
    const nodes = [no("trigger", 0), no("a", 200), no("b", 0)];
    const edges = [aresta("trigger", "a"), aresta("trigger", "b")];

    const r = organizarFluxo(nodes, edges);
    const porId = new Map(r.map((n) => [n.id, n.position]));

    expect(porId.get("a")!.y).toBe(porId.get("b")!.y);
    // "b" tinha X menor antes de organizar — continua vindo primeiro (à
    // esquerda) depois. Reorganizar não pode trocar a ordem que a pessoa
    // escolheu entre irmãos.
    expect(porId.get("b")!.x).toBeLessThan(porId.get("a")!.x);
  });

  it("ciclo (repeat volta pro nó anterior): termina, não gira para sempre", () => {
    const nodes = [no("trigger", 0), no("wait", 0), no("repeat", 0)];
    const edges = [aresta("trigger", "wait"), aresta("wait", "repeat"), aresta("repeat", "wait")];

    // A própria chamada não pode travar o teste — se organizarFluxo entrar em
    // loop infinito, este `expect` nunca roda e o vitest estoura por timeout,
    // o que já seria o vermelho que este caso existe para pegar.
    const r = organizarFluxo(nodes, edges);
    expect(r).toHaveLength(3);
  });

  it("nó desconexo (nenhuma aresta alcança) entra na última camada, não desaparece", () => {
    const nodes = [no("trigger", 0), no("wait", 0), no("ilha", 0)];
    const edges = [aresta("trigger", "wait")];

    const r = organizarFluxo(nodes, edges);
    const porId = new Map(r.map((n) => [n.id, n.position]));

    expect(r).toHaveLength(3);
    expect(porId.get("ilha")!.y).toBeGreaterThan(porId.get("wait")!.y);
  });

  it("sem raiz nenhuma (todo nó tem entrada): não trava, cai no primeiro nó da lista", () => {
    const nodes = [no("a", 0), no("b", 0)];
    const edges = [aresta("a", "b"), aresta("b", "a")];

    const r = organizarFluxo(nodes, edges);
    expect(r).toHaveLength(2);
  });

  it("preserva os outros campos do nó — só a posição muda", () => {
    const nodes = [{ ...no("trigger", 0), data: { label: "Início" } }];
    const r = organizarFluxo(nodes, []);
    expect(r[0]!.data).toEqual({ label: "Início" });
  });

  it("preserva a ORDEM do array de entrada — não reordena por camada", () => {
    // "b" está na camada 0 (raiz) e vem DEPOIS de "a" (camada 1) no array de
    // entrada. A saída tem de manter essa ordem de array, mesmo com Y
    // diferente — quem indexa a lista por posição não pode ver os nós
    // trocarem de lugar.
    const nodes = [no("a", 0), no("b", 0)];
    const edges = [aresta("b", "a")];

    const r = organizarFluxo(nodes, edges);
    expect(r.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("lista vazia não estoura", () => {
    expect(organizarFluxo([], [])).toEqual([]);
  });
});
