/**
 * Sanitiza texto ANTES dele virar `platform_event_logs.error_message`.
 *
 * `platform_event_logs` é auditoria, lida por quem administra a organização
 * — não pode virar um segundo lugar pra vazar o que `secrets_encrypted`
 * protege. `resultado.detalhe` (lib/plataformas-de-anuncio/*) já é só a
 * `message` de erro da plataforma, nunca o corpo da requisição — mas uma
 * página de erro de gateway/WAF fora do formato esperado pode conter
 * qualquer coisa, e a defesa não pode depender de todo adapter presente E
 * futuro lembrar de nunca ecoar o request. Esta função é a ÚLTIMA porta
 * antes do INSERT, não a única.
 *
 * Três padrões, dos mais específicos aos mais genéricos — ordem importa
 * porque um `Bearer <token>` já capturado pelo primeiro padrão não precisa
 * (e não deveria) ser recapturado pelo terceiro com um rótulo pior.
 */
const PADRAO_BEARER = /Bearer\s+[A-Za-z0-9._-]+/gi;
const PADRAO_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Runs alfanuméricos de 32+ chars — a forma de um token, hash ou secret. */
const PADRAO_TOKEN_LONGO = /\b[A-Za-z0-9_-]{32,}\b/g;

/** Teto de tamanho — auditoria não pode virar despejo de um corpo de erro inteiro. */
const TAMANHO_MAXIMO = 500;

export function sanitizarParaAuditoria(bruto: string | null | undefined): string | null {
  const texto = (bruto ?? "").trim();
  if (!texto) return null;
  return texto
    .slice(0, TAMANHO_MAXIMO)
    .replace(PADRAO_BEARER, "Bearer [redigido]")
    .replace(PADRAO_EMAIL, "[email]")
    .replace(PADRAO_TOKEN_LONGO, "[token]");
}
