/**
 * Markdown/text extractor for the RAG ingestion pipeline.
 *
 * Decodes the buffer (UTF-8, or windows-1252 when the density of U+FFFD
 * proves the buffer isn't valid UTF-8 — see `lib/text/decodificar-texto.ts`)
 * and strips YAML frontmatter. Returns the raw text body ready for chunking.
 *
 * `.txt` and `.md` both route through here (`lib/ai/rag/ingest/documento.ts`).
 * Before this, a `.txt`/`.md` exported from Windows in cp1252 (Bloco de
 * Notas, Excel "Salvar como texto") came out as mojibake in the knowledge
 * base — silently, same shape as issue #483 in `lib/contacts/csv.ts`, which
 * this decoder is shared with.
 */
import { decodificarTexto } from "@/lib/text/decodificar-texto";

/**
 * Extracts plain text from a markdown buffer.
 * Strips YAML frontmatter (---…---) if present.
 */
export function extractMarkdownText(buffer: Buffer): string {
  const raw = decodificarTexto(buffer).texto;

  // Strip YAML frontmatter block if it starts the file
  if (raw.trimStart().startsWith("---")) {
    // Find the closing "---" delimiter (must be on its own line after the first)
    const afterOpen = raw.indexOf("---") + 3; // skip opening ---
    const closeIdx = raw.indexOf("\n---", afterOpen);
    if (closeIdx !== -1) {
      // Return everything after the closing --- (skip the newline after it)
      return raw.slice(closeIdx + 4).replace(/^\n/, "").trim();
    }
  }

  return raw.trim();
}
