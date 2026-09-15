/**
 * Decodifica bytes de texto como UTF-8, com heurística de densidade que cai
 * para windows-1252 quando o buffer claramente NÃO é UTF-8 válido.
 *
 * Extraído de `lib/contacts/csv.ts` (`decodificarCsv`, issue #483) para ser
 * reusado fora de CSV — a base de conhecimento tem o MESMO defeito com
 * `.txt`/`.md` exportados do Windows em cp1252: `extractMarkdownText` fazia
 * `buffer.toString("utf8")` sempre, e um arquivo cp1252 virava mojibake
 * silencioso no material que o agente de IA lê para o cliente.
 *
 * A prova é a DENSIDADE de `U+FFFD` (caractere de substituição), não a mera
 * presença: `TextDecoder("utf-8")` só produz `U+FFFD` quando o byte-stream
 * não é UTF-8 válido, mas um único byte solto de sujeira (aspa curva do
 * Word, 0x92) não deve derrubar um arquivo inteiro para windows-1252 — ver o
 * comentário completo com os números medidos em `lib/contacts/csv.ts`.
 */
const MAX_BYTES_POR_SUBSTITUICAO = 100;

export interface TextoDecodificado {
  texto: string;
  /**
   * `true` quando a densidade de `U+FFFD` forçou a queda para windows-1252 —
   * quem chama e precisa desconfiar do resultado (CSV recusa byte de
   * controle nesse caminho) sabe por aqui, sem repetir a heurística.
   */
  usouWindows1252: boolean;
}

export function decodificarTexto(bytes: ArrayBuffer | Uint8Array): TextoDecodificado {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  const utf8 = new TextDecoder("utf-8").decode(buf);
  const substituicoes = (utf8.match(/�/g) ?? []).length;
  // Sem nenhuma: UTF-8 válido, e a prova é completa.
  if (substituicoes === 0) return { texto: utf8, usouWindows1252: false };
  // Com poucas: é UTF-8 com sujeira pontual, não outro charset. Trocar de
  // decoder aqui estragaria o arquivo inteiro para consertar um caractere.
  if (buf.byteLength / substituicoes > MAX_BYTES_POR_SUBSTITUICAO) {
    return { texto: utf8, usouWindows1252: false };
  }

  return { texto: new TextDecoder("windows-1252").decode(buf), usouWindows1252: true };
}
