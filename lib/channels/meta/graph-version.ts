/**
 * Versão da Graph API da Meta — usada por TODA chamada que fala com
 * `graph.facebook.com`: canal oficial (WhatsApp Cloud), validação de
 * credencial de anúncio e os scripts de spike.
 *
 * Único lugar com o literal: antes cada consumidor tinha o próprio
 * `process.env.META_GRAPH_VERSION ?? "v22.0"` — subir a versão da API virava
 * caçar a string em oito arquivos e confiar em não esquecer nenhum.
 */
export const DEFAULT_META_GRAPH_VERSION = "v22.0";

export function metaGraphVersion(): string {
  return process.env.META_GRAPH_VERSION ?? DEFAULT_META_GRAPH_VERSION;
}
