/**
 * Zod schemas for `/api/v1/contacts/*` endpoints (EPIC-05 waves 1, 2, 8).
 *
 * Contracts:
 *  - contactCreateSchema    → POST /api/v1/contacts
 *  - contactPatchSchema     → PATCH /api/v1/contacts/[id]
 *  - contactListQuerySchema → GET /api/v1/contacts (search/tag/source/cursor)
 *  - lgpdAnonymizeSchema    → POST /api/v1/lgpd/anonymize (irreversible)
 */
import { z } from "zod";

const PHONE_REGEX = /^\+\d{8,15}$/;
const CPF_DIGITS = /^\d{11}$/;

/**
 * Tag de contato — item 1 do pedido: trim + minúsculo + corte de 50 chars,
 * SEMPRE no servidor, mesmo que o front já limite. Tag também chega por API
 * de integração externa, que não passa pelo input HTML nem pelo componente
 * de chips — sem esta camada aqui, uma integração gravaria tag com espaço,
 * maiúscula ou 400 caracteres direto no banco.
 */
const tagsSchema = z
  .array(z.string())
  // "cortar em 50 caracteres" é TRUNCAR, não recusar — `.max()` do Zod
  // rejeitaria a tag inteira; o pedido quer o excesso descartado em silêncio,
  // do mesmo jeito que o componente de chips já se comporta no cliente.
  .transform((tags) => [...new Set(tags.map((tag) => tag.trim().toLowerCase().slice(0, 50)).filter(Boolean))])
  .optional();

/** Link de rede social — mesma checagem em duas camadas, servidor decide o valor final. */
function linkSchema(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .optional();
}

/**
 * Teto de 32 KB no jsonb inteiro. O CHECK do banco só garante que é OBJETO —
 * sem limite de tamanho, um cliente da API escreveria megabytes numa coluna que
 * a listagem de contatos traz inteira, e o custo apareceria como "a tela de
 * contatos ficou lenta", longe da causa.
 */
const CUSTOM_FIELDS_MAX_BYTES = 32_768;

const customFieldsSchema = z
  .record(z.string().min(1).max(80), z.unknown())
  .refine((value) => JSON.stringify(value).length <= CUSTOM_FIELDS_MAX_BYTES, {
    message: "Campos personalizados excedem o limite de 32 KB",
  });

/**
 * CPF check-digit validator (algoritmo oficial Receita Federal).
 * Rejeita repetidos (00000000000, 11111111111, ...) e dígitos verificadores inválidos.
 */
export function isValidCpf(raw: string): boolean {
  const s = raw.replace(/\D/g, "");
  if (!CPF_DIGITS.test(s) || /^(\d)\1{10}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(s[i]!, 10) * (10 - i);
  let d1 = (sum * 10) % 11;
  if (d1 === 10) d1 = 0;
  if (d1 !== parseInt(s[9]!, 10)) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(s[i]!, 10) * (11 - i);
  let d2 = (sum * 10) % 11;
  if (d2 === 10) d2 = 0;
  return d2 === parseInt(s[10]!, 10);
}

export const contactCreateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  display_name: z.string().min(1).max(200).optional(),
  // 320 = teto do RFC 5321 (64 da parte local + @ + 255 do domínio) — mesmo
  // teto já usado em `emailDoConvidado` (lib/schemas/agenda), item 6 do
  // pedido do dossiê: duas camadas, nunca só o maxLength do input.
  email: z.string().trim().email().max(320).optional(),
  phone_number: z
    .string()
    .regex(PHONE_REGEX, "Telefone deve estar em formato E.164 (+5511999998888)")
    .optional(),
  cpf: z.string().refine(isValidCpf, "CPF inválido").optional(),
  birthdate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  tags: tagsSchema,
  /** O que a pessoa digitou no dossiê, tal qual — nunca a forma canônica. */
  phone_raw: z.string().trim().max(30).optional(),
  website_url: linkSchema(500),
  instagram_url: linkSchema(500),
  facebook_url: linkSchema(500),
  /** Mais longo: a URL de local do Google Maps é naturalmente maior. */
  google_maps_url: linkSchema(1000),
  /** Cargo/função do contato na empresa dele — pedido no formulário unificado de "Novo negócio". */
  job_title: z.string().trim().max(150).optional(),
  source: z.string().min(1).default("manual"),
  source_metadata: z.record(z.string(), z.unknown()).optional(),
  consent: z.record(z.string(), z.unknown()).optional(),
  custom_fields: customFieldsSchema.optional(),
});
export type ContactCreate = z.infer<typeof contactCreateSchema>;

export const contactPatchSchema = contactCreateSchema.partial().extend({
  source: z.string().min(1).optional(),
});
export type ContactPatch = z.infer<typeof contactPatchSchema>;

export const CONTACT_ORDER_BY = [
  "last_activity_at",
  "created_at",
  "display_name",
  "email",
  "phone_number",
] as const;

export const contactListQuerySchema = z.object({
  search: z.string().optional(),
  tag: z.string().optional(),
  source: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  order_by: z.enum(CONTACT_ORDER_BY).default("last_activity_at"),
  order_dir: z.enum(["asc", "desc"]).default("desc"),
});
export type ContactListQuery = z.output<typeof contactListQuerySchema>;
export type ContactListQueryParams = z.input<typeof contactListQuerySchema>;
export type ContactOrderBy = (typeof CONTACT_ORDER_BY)[number];

export const lgpdAnonymizeSchema = z.object({
  contact_id: z.string().uuid(),
  justification: z.string().min(10).max(1000),
});
export type LgpdAnonymizeInput = z.infer<typeof lgpdAnonymizeSchema>;

/**
 * Juntar contatos duplicados.
 *
 * O principal fica FORA do array de secundários e o `refine` é o que garante
 * isso na borda — `fn_mesclar_contatos` recusa o mesmo caso com `22023`, mas um
 * 422 com a lista de campos é o que a tela consegue mostrar. As duas guardas
 * existem porque a rota não é a única porta: a RPC é alcançável por
 * `authenticated` (é assim que a RLS a autoriza), e ela precisa se defender só.
 *
 * O teto de 20 secundários por chamada não é arbitrário: a fusão trava as
 * linhas (`for update`) e reponta toda FK que aponta para elas: um lote grande
 * segura escrita de contato para a organização inteira enquanto roda.
 */
export const contactsMergeSchema = z
  .object({
    primary_contact_id: z.string().uuid(),
    secondary_contact_ids: z.array(z.string().uuid()).min(1).max(20),
  })
  .refine((v) => !v.secondary_contact_ids.includes(v.primary_contact_id), {
    message: "O contato principal não pode estar entre os que serão absorvidos.",
    path: ["secondary_contact_ids"],
  })
  .refine((v) => new Set(v.secondary_contact_ids).size === v.secondary_contact_ids.length, {
    message: "Contato repetido na seleção.",
    path: ["secondary_contact_ids"],
  });
export type ContactsMergeInput = z.infer<typeof contactsMergeSchema>;
