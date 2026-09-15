import { describe, expect, it } from "vitest";

import { extractMarkdownText } from "@/lib/ai/rag/extractors/markdown";

/**
 * `.txt`/`.md` EM CP1252 (WINDOWS) NÃO ENTRAM COMO MOJIBAKE NA BASE DE
 * CONHECIMENTO.
 *
 * Achado no changelog do upstream, mesma família do defeito já corrigido
 * para CSV (issue #483, `lib/contacts/csv.ts`): `extractMarkdownText` fazia
 * `buffer.toString("utf8")` incondicional. Um `.txt` exportado do Bloco de
 * Notas ou Excel em cp1252 virava "AÃ§Ã£o"/`A�o` — silenciosamente, no
 * material que o agente de IA lê literalmente para o cliente.
 */

const cp1252 = (texto: string) => Buffer.from(texto, "latin1");

describe("extractMarkdownText com bytes cp1252", () => {
  it("acento em cp1252 chega correto, não corrompido", () => {
    const texto = extractMarkdownText(cp1252("# Política de Devolução\n\nAção em até 7 dias, sem Condição prévia."));

    expect(texto).toContain("Política de Devolução");
    expect(texto).toContain("Ação em até 7 dias, sem Condição prévia.");
    expect(texto).not.toContain("�");
  });

  it("UTF-8 continua UTF-8 (não regride o caminho comum)", () => {
    const texto = extractMarkdownText(Buffer.from("# Política\n\nAção Cônica Ç", "utf8"));

    expect(texto).toBe("# Política\n\nAção Cônica Ç");
  });

  it("frontmatter YAML continua sendo removido depois da decodificação", () => {
    const texto = extractMarkdownText(cp1252("---\ntitulo: Política\n---\nConteúdo com Ação e Ç."));

    expect(texto).not.toContain("titulo:");
    expect(texto).toBe("Conteúdo com Ação e Ç.");
  });
});
