/**
 * DE ONDE O JEV É SERVIDO — a TypeSafe direto, ou via OpenRouter.
 *
 * O Jev é um modelo da TypeSafe AI, e há DOIS caminhos até ele. A diferença é de
 * endereço, de nome de modelo e de credencial — e nenhuma das três é cosmética:
 *
 *  - `typesafe` — o endereço da TypeSafe (`https://api.typesafe.ai`), o modelo
 *    fixado `jev-1.13.0`, e uma chave da própria TypeSafe. É o caminho de
 *    sempre, e continua sendo o padrão.
 *  - `openrouter` — o roteador da OpenRouter (`https://openrouter.ai/api`), o
 *    MESMO Jev com o nome prefixado `typesafe/jev-1.13`, e a credencial
 *    OpenRouter que a organização já tenha cadastrado. Quem já usa OpenRouter
 *    liga o Jev sem segunda conta, segundo cartão de crédito e segunda chave.
 *
 * ═══ POR QUE O NOME DO MODELO NÃO É O MESMO ═══
 *
 * A OpenRouter responde `400 Model typesafe/jev-1.13.0 does not exist` para o
 * nome da TypeSafe (medido pelo autor da issue #2947 em 15/10/2026, com 200 e
 * `provider: TypeSafe` para `typesafe/jev-1.13`). Mandar o nome da TypeSafe para
 * a OpenRouter é um 400, que o cliente traduz em `contrato_invalido` — e o
 * operador leria "a pergunta é nossa e está errada" para uma chamada que estava
 * certa.
 *
 * ═══ POR QUE A PROVA DA CHAVE MUDA DE CAMINHO ═══
 *
 * A TypeSafe prova a chave em `GET /v1/models`, que EXIGE credencial. Na
 * OpenRouter esse catálogo é PÚBLICO: responde 200 para qualquer string, e
 * validar por ele gravaria QUALQUER chave como "validada" (o mesmo defeito que
 * `lib/ai/provider-validators.ts` já documenta para o provedor OpenRouter). Quem
 * prova a chave é `GET /v1/key`, que exige credencial.
 *
 * A base das duas origens é o ambiente do DUBLÊ do e2e (`JEV_API_BASE_URL`,
 * lido em `./cliente`): ele responde as duas pelo mesmo endereço local, e quem
 * aponta a instalação para um proxy manda nas duas — a variável é um override
 * explícito de quem instalou.
 *
 * Este módulo não importa NADA de propósito: ele carrega vocabulário (nomes de
 * modelo, base, provedor da credencial, caminho da prova) e é lido por
 * componente de tela (`CartaoDoJev`) — um `import` aqui arrastaria o que ele
 * trouxesse para o bundle do navegador. O `env` fica em quem monta a URL.
 */
export const ORIGENS_DO_JEV = ["typesafe", "openrouter"] as const;
export type OrigemDoJev = (typeof ORIGENS_DO_JEV)[number];

/** O caminho de sempre. Escolher origem é opt-in, e o default não muda. */
export const ORIGEM_PADRAO: OrigemDoJev = "typesafe";

/** A base da API de cada origem. Sem barra final: o caminho entra por concatenação. */
const BASE: Record<OrigemDoJev, string> = {
  typesafe: "https://api.typesafe.ai",
  openrouter: "https://openrouter.ai/api",
};

/**
 * O nome do modelo em cada origem. O da TypeSafe é a VERSÃO FIXADA, não o
 * apelido `jev-latest` — o limiar de passagem para humano foi calibrado sobre
 * ela, e o apelido anda sozinho quando o fornecedor publica versão nova.
 */
export const MODELO_DA_TYPESAFE = "jev-1.13.0";
/** O MESMO Jev, com o nome que a OpenRouter conhece. Nunca acrescente `.0`. */
export const MODELO_NA_OPENROUTER = "typesafe/jev-1.13";

const MODELO: Record<OrigemDoJev, string> = {
  typesafe: MODELO_DA_TYPESAFE,
  openrouter: MODELO_NA_OPENROUTER,
};

/**
 * A credencial que cada origem usa. A OpenRouter reaproveita a que a organização
 * já cadastrou para a conversa: é o ganho que a issue #2947 pede.
 */
const PROVEDOR: Record<OrigemDoJev, "typesafe" | "openrouter"> = {
  typesafe: "typesafe",
  openrouter: "openrouter",
};

/** O caminho que PROVA a chave em cada origem — ver o cabeçalho. */
const CAMINHO_DA_PROVA: Record<OrigemDoJev, string> = {
  typesafe: "/v1/models",
  openrouter: "/v1/key",
};

/**
 * A base PADRÃO daquela origem, sem o override da instalação. Quem monta a URL
 * de verdade é `baseDaApiDoJev` (`./cliente`), que lê `JEV_API_BASE_URL` antes
 * deste valor.
 */
export function basePadraoDaOrigem(origem: OrigemDoJev = ORIGEM_PADRAO): string {
  return BASE[origem];
}

/** O nome do modelo daquela origem. */
export function modeloDaOrigem(origem: OrigemDoJev = ORIGEM_PADRAO): string {
  return MODELO[origem];
}

/** O provedor da credencial que aquela origem consome. */
export function provedorDaCredencial(origem: OrigemDoJev = ORIGEM_PADRAO): "typesafe" | "openrouter" {
  return PROVEDOR[origem];
}

/** O caminho em que a chave daquela origem é provada. */
export function caminhoDaProva(origem: OrigemDoJev = ORIGEM_PADRAO): string {
  return CAMINHO_DA_PROVA[origem];
}
