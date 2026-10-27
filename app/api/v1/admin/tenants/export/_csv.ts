/**
 * O ARQUIVO CSV dos tenants — colunas, escape e o redigimento (issue #2777).
 *
 * ─── O envelope é o do export que já existe ────────────────────────────────
 *
 * Mesma forma de `app/api/v1/audit/export/route.ts` e do export de contatos
 * (#2759/PR #2772): BOM UTF-8 na frente (o Excel em português precisa dele para
 * ler acento), aspas RFC 4180 (`"`, vírgula e quebra de linha dentro da célula)
 * e `Content-Disposition` datado — um só formato na plataforma, não dois.
 *
 * ─── O redigimento: o centro desta issue ───────────────────────────────────
 *
 * O worker de LGPD que anonimiza um TENANT só vira `organizations.status` para
 * `redacted` (`workers/lgpd-redact-worker.ts`) — ele NÃO limpa `display_name`,
 * `legal_name` nem `cnpj`, que seguem na tabela como estavam antes. Ou seja: a
 * plataforma prometeu não guardar mais aqueles dados e a tabela guarda; quem
 * exporta é quem decide se entrega exatamente o que a anonimização jurou
 * apagar.
 *
 * Por isso o corte é AQUI, antes de escrever a linha, e a regra vem de
 * `lib/lgpd/cascata.ts` — o arquivo que já é a fonte única do que significa
 * "redigido" (issues #310 e #701). Duas decisões dentro dela:
 *
 *  - `display_name` e `legal_name` saem como `NOTA_REDIGIDA`, o marcador que a
 *    própria cascata usa para texto apagado. O valor que a anonimização JÁ
 *    redigiu passa intacto (`jaRedigida`/`SUFIXO_ANONIMIZADO`): a regra é
 *    idempotente, como a cascata inteira — reescrever um texto já redigido é o
 *    defeito que o sufixo existe para impedir;
 *  - `cnpj` sai VAZIO. Documento não tem forma redigida: o que não existe mais
 *    é vazio, e a coluna `status` já diz `redacted`.
 *
 * `id` e `slug` ficam: são o identificador técnico, e sem eles o arquivo não é
 * inventário nenhum — é a lista de instalações que a issue pede.
 */
import type { AdminTenantRow } from "@/hooks/useAdminTenants";
import { neutralizarFormula } from "@/lib/csv/neutralizar-formula";
import { NOTA_REDIGIDA, jaRedigida } from "@/lib/lgpd/cascata";

/**
 * As 11 colunas da `AdminTenantRow` (`hooks/useAdminTenants.ts`), NA ORDEM em
 * que a rota de leitura as devolve. Sem campo inventado: uma coluna que a tela
 * não tem seria resposta para pergunta que ninguém fez.
 */
export const COLUNAS_DO_CSV = [
  "id",
  "slug",
  "display_name",
  "legal_name",
  "cnpj",
  "status",
  "onboarded_at",
  "suspended_at",
  "created_at",
  "user_count",
  "conversations_count",
] as const;

/**
 * RFC 4180, mais a neutralização de célula que começa com caractere de fórmula.
 *
 * `display_name` e `legal_name` são gravados pelo próprio tenant, e uma célula
 * que começa com `=`, `+`, `-`, `@`, TAB ou CR é lida como FÓRMULA pelo Excel e
 * pelo LibreOffice. A aspa simples na frente faz a planilha mostrar o texto
 * como texto. Só vale para `string`: número (a contagem) não passa por aqui.
 */
function csvEscape(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  const texto = typeof valor === "string" ? neutralizarFormula(valor) : String(valor);
  if (/[",\n\r]/.test(texto)) return `"${texto.replace(/"/g, '""')}"`;
  return texto;
}

/**
 * A contagem vira NÚMERO SIMPLES.
 *
 * A leitura devolve `[{ count: 3 }]` (embed do PostgREST); o CSV não é JSON, e
 * `{` numa célula seria o arquivo se confundindo com o que ele veio substituir.
 */
function contagem(valor: unknown): string | number {
  if (valor === null || valor === undefined) return "";
  if (Array.isArray(valor)) return (valor[0] as { count?: number } | undefined)?.count ?? 0;
  if (typeof valor === "object") {
    const count = (valor as { count?: unknown }).count;
    return typeof count === "number" ? count : "";
  }
  return valor as string | number;
}

/** O texto de identidade de um tenant `redacted`, pelo marcador da cascata. */
function textoRedigido(valor: string | null): string | null {
  if (valor === null) return null;
  // Já redigido pela anonimização: é ESSE valor que vai para o arquivo, e
  // reescrevê-lo comeria a marca que torna a leitura possível.
  if (valor === NOTA_REDIGIDA || jaRedigida(valor)) {
    return valor;
  }
  return NOTA_REDIGIDA;
}

/** Uma linha de dados — na ordem exata de `COLUNAS_DO_CSV`. */
export function linhaDoCsv(linha: AdminTenantRow): string {
  const redigida = linha.status === "redacted";
  return [
    linha.id,
    linha.slug,
    redigida ? textoRedigido(linha.display_name) : linha.display_name,
    redigida ? textoRedigido(linha.legal_name) : linha.legal_name,
    redigida ? null : linha.cnpj,
    linha.status,
    linha.onboarded_at,
    linha.suspended_at,
    linha.created_at,
    contagem(linha.user_count),
    contagem(linha.conversations_count),
  ]
    .map(csvEscape)
    .join(",");
}

/** BOM + cabeçalho + linhas. */
export function csvDosTenants(linhas: readonly AdminTenantRow[]): string {
  const linhasDoArquivo = [COLUNAS_DO_CSV.join(","), ...linhas.map(linhaDoCsv)];
  return `\uFEFF${linhasDoArquivo.join("\n")}\n`;
}

/**
 * `tenants-YYYY-MM-DD.csv` — o MESMO formato do export de auditoria
 * (`audit-YYYY-MM-DD.csv`), só muda o prefixo: o nome do arquivo diz QUANDO a
 * base foi tirada.
 */
export function nomeDoArquivo(hoje: Date = new Date()): string {
  return `tenants-${hoje.toISOString().slice(0, 10)}.csv`;
}
