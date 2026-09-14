/**
 * Normalização de link (site/Instagram/Facebook/Google Maps) — item 2 do
 * pedido. Puro, sem dependência de servidor: usado tanto no botão "abrir em
 * nova aba" (client) quanto na gravação (server), pra garantir protocolo
 * ANTES de montar o href ou de salvar no banco — sem isso, "www.empresa.com"
 * vira link relativo da própria página (`meucrm.com/lead/www.empresa.com`).
 *
 * `normalizado` é só pra comparação/dedupe — nunca vira `href`: ele não tem
 * protocolo, então usá-lo como link quebraria a mesma forma que este arquivo
 * existe pra evitar.
 */
export interface LinkNormalizado {
  /** Sempre com protocolo garantido — é o único que pode virar `<a href>`. */
  href: string;
  /** minúsculo, sem protocolo, sem "www.", sem barra final. Só comparação. */
  normalizado: string;
}

export function normalizarLink(bruto: string): LinkNormalizado | null {
  const valor = bruto.trim();
  if (!valor) return null;

  const href = /^https?:\/\//i.test(valor) ? valor : `https://${valor}`;

  const normalizado = href
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");

  return { href, normalizado };
}
