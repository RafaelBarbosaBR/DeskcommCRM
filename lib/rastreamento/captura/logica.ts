/**
 * Os pedaços do tracker.js sensíveis o bastante pra merecer teste unitário
 * de verdade — cálculo de `_fbc`, detecção de link de WhatsApp, extração de
 * UTM/click-id. O tracker.js servido em `app/api/v1/track/t.js/route.ts` é
 * JS puro (sem bundler, roda direto no site do cliente) e reimplementa esta
 * MESMA lógica textualmente — mantenha os dois em sincronia quando mexer
 * aqui. Os testes deste arquivo são a fonte da verdade do algoritmo; o
 * tracker.js é a fonte da verdade do que roda no browser.
 */

/**
 * `_fbc` pela spec oficial da Meta: `fb.1.<creation_time_ms>.<fbclid>`.
 * `1` é o identificador de subdomínio (sempre 1, first-party). Nunca chamado
 * quando `fbclid` está ausente — quem chama decide isso, esta função só
 * formata.
 */
export function calcularFbc(fbclid: string, timestampMs: number): string {
  return `fb.1.${timestampMs}.${fbclid}`;
}

const RE_WHATSAPP_HTTP = /^(?:https?:)?\/\/(?:[a-z0-9-]+\.)?(?:wa\.me|whatsapp\.com)(?:[/?#]|$)/i;
const RE_WHATSAPP_SCHEME = /^whatsapp:\/\//i;

/** Cobre wa.me, whatsapp.com (qualquer subdomínio: api./web./chat.) e whatsapp://. */
export function ehLinkDeWhatsApp(href: string): boolean {
  const alvo = href.trim();
  return RE_WHATSAPP_HTTP.test(alvo) || RE_WHATSAPP_SCHEME.test(alvo);
}

export interface ParametrosDeRastreio {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  fbclid: string | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
}

const CHAVES: (keyof ParametrosDeRastreio)[] = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "gbraid",
  "wbraid",
];

/** Nunca inventa: parâmetro ausente na URL vira `null`, nunca string vazia. */
export function extrairParametrosDeRastreio(url: string): ParametrosDeRastreio {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    params = new URLSearchParams();
  }
  const resultado = {} as ParametrosDeRastreio;
  for (const chave of CHAVES) {
    const valor = params.get(chave);
    resultado[chave] = valor && valor.trim() ? valor.trim() : null;
  }
  return resultado;
}
