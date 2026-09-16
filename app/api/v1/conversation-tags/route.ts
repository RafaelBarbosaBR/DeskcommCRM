/**
 * GET /api/v1/conversation-tags — vocabulário canônico de tags de conversa da
 * org ativa (spec 13 §3.3, G3-05). Sugestões para o inbox.
 *
 * Server route (não query browser-supabase direta): o cookie de sessão é
 * HttpOnly, então o client do browser não lê a sessão — leitura autenticada
 * passa pelo servidor, mesmo padrão do board de pipelines.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { canonicalConversationTagsSchema } from "@/lib/schemas/settings";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const [{ data, error }, emUso] = await Promise.all([
    supabase.from("organizations").select("settings").eq("id", activeOrg.orgId).maybeSingle(),
    // Etiqueta aplicada direto numa conversa (edição avulsa, import, automação)
    // sem nunca ter sido cadastrada no vocabulário canônico abaixo não aparecia
    // como opção de filtro — mesmo já estando em uso. `fn_tags_de_conversa_em_uso`
    // faz a agregação `unnest`+`distinct` que o PostgREST não fala direto.
    supabase.rpc("fn_tags_de_conversa_em_uso", { p_org: activeOrg.orgId }),
  ]);
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (emUso.error) return fail("internal_error", emUso.error.message, 500, { requestId });

  const raw = (data?.settings as Record<string, unknown> | null)?.[
    "canonical_conversation_tags"
  ];
  const cadastradas = canonicalConversationTagsSchema.parse(raw ?? []);
  // Dedupe ANTES de validar de novo: `canonicalConversationTagsSchema` aplica
  // `.max(50)` sobre o array cru, antes do `.transform` que remove duplicata —
  // juntar as duas listas sem desduplicar primeiro podia estourar o teto só
  // de contar a mesma tag duas vezes, e `.catch([])` apagaria as cadastradas
  // em silêncio.
  const tags = canonicalConversationTagsSchema.parse([
    ...new Set([...cadastradas, ...(emUso.data ?? [])]),
  ]);
  return ok(tags, { requestId });
}
