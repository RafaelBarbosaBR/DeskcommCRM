/**
 * A aspa simples que faz a planilha mostrar texto como texto, e não avaliar como
 * fórmula, na frente de todo trecho de célula que começa com `=`, `+`, `-`, `@`,
 * TAB ou CR.
 *
 * "Todo trecho", e não só o começo da célula, porque quem lê o CSV nem sempre
 * divide como o RFC 4180: o Excel em pt-BR divide por `;`, e ali as aspas de um
 * campo que não começa com aspa não protegem nada (uma quebra de linha abre linha
 * nova); um leitor sem aspas divide em `,`. Todo trecho que começa depois de `;`,
 * `,`, LF ou CR pode virar célula.
 *
 * Número puro passa intacto (telefone E.164, `-2` dentro de um JSON): a planilha
 * o lê como número, sem função, e a aspa quebraria o dado.
 */
const GATILHO = /^[=+\-@\t\r]/;
const NUMERO = /^[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?[\]}]*$/;

export function neutralizarFormula(texto: string): string {
  return texto
    .split(/(?<=[;,\n\r])/)
    .map((trecho) => (GATILHO.test(trecho) && !NUMERO.test(trecho) ? `'${trecho}` : trecho))
    .join("");
}
