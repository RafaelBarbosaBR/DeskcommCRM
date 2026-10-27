/**
 * QUAL CHAVE O JEV USA — a regra, sobre linhas já lidas.
 *
 * `chaveDaOrganizacao` (`./ponto.ts`) aplica esta mesma regra em SQL para
 * decifrar a chave. As telas e as rotas precisam da LINHA (rótulo, erro de
 * validação), não do segredo, e é aqui que elas perguntam — uma cópia da regra
 * por leitor é como "a chave que o cartão mostra" e "a chave que sai para a
 * rede" passam a ser duas.
 */
import { ORIGEM_PADRAO, provedorDaCredencial, type OrigemDoJev } from "./origem";

import type { IDS_DE_PROVEDOR_DE_DECISAO } from "@/lib/ai/pontos/provedores";

export const PROVEDOR_DO_JEV = "typesafe" satisfies (typeof IDS_DE_PROVEDOR_DE_DECISAO)[number];

export interface LinhaDeCredencial {
  provider: string;
  is_active: boolean;
  validated_at: string | null;
  created_at: string;
}

/**
 * A credencial do provedor da ORIGEM do Jev, ativa e validada, mais recente.
 * Chave colada e ainda não conferida não conta: ela não sai para a rede.
 *
 * A origem entra porque ela escolhe o PROVEDOR (`./origem`): no caminho de
 * sempre é a chave do Jev na TypeSafe; via OpenRouter é a credencial OpenRouter
 * que a organização já cadastrou para a conversa — sem segunda conta, segundo
 * cartão e segunda chave, que é o ganho que a issue #2947 pede. Ausente é o
 * padrão (TypeSafe direto), como antes.
 */
export function credencialEmUsoPeloJev<T extends LinhaDeCredencial>(
  linhas: readonly T[],
  origem: OrigemDoJev = ORIGEM_PADRAO,
): T | null {
  const provedor = provedorDaCredencial(origem);
  const aptas = linhas.filter(
    (c) => c.provider === provedor && c.is_active && c.validated_at !== null,
  );
  return aptas.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null;
}
