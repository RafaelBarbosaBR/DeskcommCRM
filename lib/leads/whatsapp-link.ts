/**
 * Gerador de link do WhatsApp — item 3 do pedido. Puro e derivado em tempo
 * real do campo Telefone, sem precisar salvar antes.
 *
 * A heurística de código de país é CONFIGURÁVEL POR CONTA
 * (`organizations.whatsapp_default_country_code`), nunca fixa no código —
 * por isso `codigoPaisPadrao` é parâmetro, não constante. Não usa
 * `lib/channels/phone-variants.ts`: aquele arquivo resolve um problema
 * diferente (dedupe de contato pelo canal de mensagens, só Brasil); este
 * resolve "que dígitos colocar depois de wa.me/", pra qualquer conta.
 */
/**
 * O que foi digitado no dossiê, em E.164 (`+<dígitos>`), pro caminho de save
 * que grava `contacts.phone_number` (a coluna canônica, que já existia).
 * Mesma heurística de 10/11 dígitos do gerador de link — nunca fixa no país.
 * `null` quando não sobra dígito nenhum (não força e-mail vazio a virar
 * `"+"` na tentativa de salvar).
 */
export function paraE164ComCodigoPadrao(
  digitado: string,
  codigoPaisPadrao: string,
): string | null {
  const alvo = digitado.trim();
  const digitos = alvo.replace(/\D/g, "");
  if (!digitos) return null;
  if (alvo.startsWith("+")) return `+${digitos}`;
  if (digitos.length === 10 || digitos.length === 11) return `+${codigoPaisPadrao}${digitos}`;
  return `+${digitos}`;
}

export function gerarLinkWhatsApp(
  digitado: string | null | undefined,
  codigoPaisPadrao: string,
): string | null {
  const digitos = (digitado ?? "").replace(/\D/g, "");
  if (!digitos) return null;

  // 10 ou 11 dígitos = padrão nacional com DDD, sem código de país — prefixa
  // o código configurado pela conta. Mais longo que isso já veio com código
  // de país (ex.: 13 dígitos = 55 + DDD + celular) — só formata, não mexe.
  const comCodigo = digitos.length === 10 || digitos.length === 11 ? `${codigoPaisPadrao}${digitos}` : digitos;

  return `https://wa.me/${comCodigo}`;
}
