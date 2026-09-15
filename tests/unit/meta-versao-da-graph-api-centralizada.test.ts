/**
 * SÓ UM LUGAR CONHECE A VERSÃO DA GRAPH API DA META.
 *
 * `lib/channels/meta/graph-version.ts` (o literal `"v22.0"`, escrito uma vez)
 * é o único arquivo autorizado a ter o literal solto — canal oficial, os
 * módulos de anúncio (Conversions/Insights/rastreamento) e os scripts de
 * spike importam dali. Achado no changelog do upstream: subir a versão da API
 * virava caçar `"v22.0"` em oito arquivos e confiar em não esquecer nenhum —
 * esta varredura é o que substitui aquela confiança por prova.
 *
 * Prosa (comentário/docstring) não conta: `template-sync.ts` explica, em
 * texto, que a Meta reescreve a versão no `paging.next` — isso é ensino, não
 * um literal vivo. A varredura por isso ignora linha que É comentário.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

const ARQUIVO_DA_CONSTANTE = "lib/channels/meta/graph-version.ts";

const RAIZES = ["app", "lib", "scripts", "components", "workers"] as const;

/**
 * `vNN.0` — o formato real de versão da Graph API (sempre dois dígitos e
 * `.0`, nunca outro shape) — fora de comentário de linha ou bloco.
 *
 * `\d{1,3}\.\d+` genérico demais: casava `app/design/page.tsx`'s "v0.1" (o
 * rótulo do design system), que não tem nada a ver com Meta.
 */
const LITERAL_DE_VERSAO = /\bv\d{2}\.0\b/;

function linhasSemComentario(texto: string): string[] {
  const semBloco = texto.replace(/\/\*[\s\S]*?\*\//g, "");
  return semBloco.split("\n").filter((linha) => !linha.trim().startsWith("//"));
}

describe("versão da Graph API da Meta — um literal só", () => {
  it("controle positivo: a varredura encontra o arquivo da constante", () => {
    const arquivos = arquivosDeCodigo(RAIZES).map(caminhoRelativo);
    expect(arquivos).toContain(ARQUIVO_DA_CONSTANTE);
  });

  it("nenhum outro arquivo tem o literal vNN.N da Graph API fora de comentário", () => {
    const infratores: string[] = [];
    for (const absoluto of arquivosDeCodigo(RAIZES)) {
      const relativo = caminhoRelativo(absoluto);
      if (relativo === ARQUIVO_DA_CONSTANTE) continue;
      const texto = readFileSync(absoluto, "utf8");
      const linhasVivas = linhasSemComentario(texto).join("\n");
      if (LITERAL_DE_VERSAO.test(linhasVivas)) infratores.push(relativo);
    }
    expect(infratores).toEqual([]);
  });
});
