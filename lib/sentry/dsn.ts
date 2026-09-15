/**
 * DSN do Sentry com opt-out em runtime — modelo "telemetria de comunidade".
 *
 * Por padrão, erros vão pro Sentry do projeto (DEFAULT_SENTRY_DSN): num open source
 * self-host, é o que dá visibilidade pra corrigir bugs que afetam todo mundo. Quem
 * hospeda controla isso pelo `.env`, SEM rebuild da imagem:
 *
 *   SENTRY_DSN=off           → desliga toda a telemetria (nada é enviado)
 *   SENTRY_DSN=<seu-dsn>     → manda os erros pro SEU Sentry
 *   SENTRY_DSN=  (vazio)     → usa o Sentry da comunidade (padrão)
 *
 * Vale para servidor (process.env) e navegador (window.__PUBLIC_ENV__.SENTRY_DSN,
 * injetado em runtime pelo <PublicEnvScript/>). O DSN não é segredo — DSNs do Sentry
 * são públicos por design.
 */
export const DEFAULT_SENTRY_DSN =
  "https://58fabf8ad54504863d404a3647ef3714@o4509908078559232.ingest.us.sentry.io/4509908083212288";

export function resolveSentryDsn(value: string | undefined | null): string | undefined {
  const v = (value ?? "").trim().toLowerCase() === "off" ? "off" : (value ?? "").trim();
  if (v === "off" || v === "false" || v === "0") return undefined;
  return v.length > 0 ? v : DEFAULT_SENTRY_DSN;
}

/**
 * Estamos mandando para o Sentry da COMUNIDADE (o nosso), e não para o do operador?
 *
 * Isso decide a amostragem (issue #100). No DSN da comunidade só vai ERRO:
 * `tracesSampleRate` e `replaysSessionSampleRate` vão a 0. O que ajuda a corrigir
 * "bug que afeta todo mundo" é o stack trace — não 100% das transações nem 10% das
 * sessões de um CRM que não é nosso. Quem aponta para o próprio Sentry recebe tudo,
 * porque aí o dado não sai da infraestrutura de quem é dono dele.
 */
export function isCommunityDsn(dsn: string | undefined): boolean {
  return dsn === DEFAULT_SENTRY_DSN;
}

/** Integração default do SDK que emite as sessões de release health do browser. */
export const INTEGRACAO_DE_SESSAO = "BrowserSession";

/**
 * Integração default que instrumenta Web Vitals/navegação mesmo com
 * `tracesSampleRate: 0` — a amostragem decide SE um trace é enviado, não se o
 * coletor roda. No DSN da comunidade ela nunca manda nada (issue #100) e ainda
 * assim fica ouvindo a Performance API do navegador; uma extensão que mexe
 * nela pode derrubar esse coletor com erro no console de quem hospeda, sem
 * nenhum trace ter sido enviado para justificar o custo.
 */
export const INTEGRACAO_DE_TRACING = "BrowserTracing";

/**
 * Quais integrações do browser valem para o DSN em uso.
 *
 * A política de `isCommunityDsn` estava DECLARADA e não estava em vigor. As duas
 * amostragens foram a zero (`tracesSampleRate`, `replaysSessionSampleRate`) e o
 * fluxo de SESSÃO ficou de fora da conta: `browserSessionIntegration` entra por
 * default no `@sentry/browser` e o `lifecycle` dela é `"route"`, então cada troca
 * de rota fecha uma sessão e abre outra — duas por navegação, `errors: 0`.
 *
 * Sessão não é stack trace: ela não explica bug de ninguém, e é exatamente o que o
 * comentário do `isCommunityDsn` diz não querer ("não 100% das transações nem 10%
 * das sessões de um CRM que não é nosso"). O custo era invisível porque o dado ia
 * embora sozinho.
 *
 * Medido em 2026-08-10 sobre `dc2f9f96`, um percurso de 7 telas: 17 respostas do
 * ingest, TODAS `429`, com `x-sentry-rate-limits: 60::organization:suspended` —
 * lista de categorias vazia, isto é, todas as categorias. A organização estava
 * suspensa por cota, então nem o erro real de instalação real entrava; e cada
 * tentativa barrada virava erro de console no browser de quem hospeda.
 *
 * Quem aponta para o PRÓPRIO Sentry continua recebendo tudo, sessão inclusive: lá
 * o dado não sai da infraestrutura de quem é dono dele, e release health é
 * legítimo. A assimetria é a mesma das amostragens.
 *
 * Pela mesma lógica, `browserTracingIntegration` (Web Vitals/navegação) também
 * sai: ela entra por default independente de `tracesSampleRate`, então ficava
 * instrumentando o browser sem nunca mandar um trace no DSN da comunidade — só
 * o risco de uma extensão de navegador derrubá-la com erro no console de quem
 * hospeda, por um dado que nunca seria enviado mesmo.
 */
export function integracoesDoCliente<T extends { name: string }>(
  padraoDoSdk: readonly T[],
  paraAComunidade: boolean,
): T[] {
  if (!paraAComunidade) return [...padraoDoSdk];
  return padraoDoSdk.filter(
    (i) => i.name !== INTEGRACAO_DE_SESSAO && i.name !== INTEGRACAO_DE_TRACING,
  );
}
