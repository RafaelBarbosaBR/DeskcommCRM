/**
 * A MENSAGEM LEGÍVEL DE UM ERRO QUE PODE NÃO SER `Error`.
 *
 * ═══ O defeito que este módulo existe para acabar (issue #2980) ═══
 *
 * As ações de automação traduziam toda falha com o mesmo idioma:
 *
 *     err instanceof Error ? err.message : String(err)
 *
 * Quando o que chega NÃO é `Error` — e o caso comum é o erro do PostgREST,
 * que é um OBJETO `{ code, message, details, hint }`, não uma exceção — o ramo
 * `String(err)` produz a string literal `"[object Object]"`. O
 * `automation_rule_runs.error` grava exatamente isso, e o operador que abre a
 * aba Atividade para saber "por que a ação falhou?" lê `[object Object]`: a
 * linha diz que falhou e esconde o motivo (a mensagem e o `code` estavam ali o
 * tempo todo, dentro do objeto).
 *
 * ═══ O contrato ═══
 *
 *   - `Error` continua saindo como `err.message` (o `code` do erro entra ao
 *     lado quando existe — não muda o texto de quem já lança `Error` sem code);
 *   - OBJETO com cara de erro (`message`/`details`/`code`) → extrai o texto de
 *     gente e o código, separados por " — ";
 *   - OBJETO sem esses campos → os NOMES dos campos, nunca os valores (um
 *     objeto qualquer pode carregar cabeçalho, token ou corpo), e um texto
 *     explícito quando não há campo nenhum — nunca `"[object Object]"`;
 *   - PRIMITIVO (string, número, `null`, `undefined`) → `String(erro)`.
 *
 * O `limite` existe para as chamadas que já truncavam a mensagem (a de
 * `send_ai_message` cortava em 160) — truncar continua sendo decisão de quem
 * chama, não esconderijo de defeito.
 */

/** `code` do PostgREST é string; aceitamos número por defesa. */
function comoTexto(valor: unknown): string | null {
  if (typeof valor === "string" && valor.trim() !== "") return valor;
  if (typeof valor === "number") return String(valor);
  return null;
}

function comoCodigo(valor: unknown): string | null {
  // Só texto: o `code` numérico do DOMException (20 abort, 23 timeout) é
  // legado e não diz nada a quem lê.
  return typeof valor === "string" && valor.trim() !== "" ? valor : null;
}

function deObjeto(erro: object): string | null {
  const obj = erro as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
  const partes: string[] = [];
  const texto = comoTexto(obj.message) ?? comoTexto(obj.details) ?? comoTexto(obj.hint);
  if (texto) partes.push(texto);
  const codigo = comoCodigo(obj.code);
  if (codigo) partes.push(`código ${codigo}`);
  if (partes.length > 0) return partes.join(" — ");

  // Nomes dos campos, nunca os valores: um objeto qualquer pode carregar
  // cabeçalho, token ou corpo.
  const campos = Object.keys(erro);
  return campos.length > 0 ? `erro sem mensagem (campos: ${campos.join(", ")})` : "erro sem mensagem";
}

/** Texto legível de `erro`, com teto opcional (para caber no run). */
export function mensagemDeErro(erro: unknown, limite?: number): string {
  let texto: string;
  if (erro instanceof Error) {
    const codigo = comoCodigo((erro as { code?: unknown }).code);
    texto = codigo ? `${erro.message} — código ${codigo}` : erro.message;
  } else if (erro !== null && typeof erro === "object") {
    texto = deObjeto(erro) ?? "erro sem mensagem";
  } else {
    texto = String(erro);
  }
  return limite !== undefined && texto.length > limite ? texto.slice(0, limite) : texto;
}
