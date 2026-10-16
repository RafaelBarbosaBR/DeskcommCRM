/**
 * GET    /api/v1/telefonia/api4com — estado da conexão da org ativa (manager+),
 *                                    via view segura (nunca expõe o token cifrado).
 * POST   /api/v1/telefonia/api4com — conecta/reconecta (admin). Body:
 *                                    { email, password, domain }. A senha
 *                                    NUNCA é persistida — ver conectarApi4com.
 * DELETE /api/v1/telefonia/api4com — desconecta (admin). O mapeamento de
 *                                    ramais (api4com_extensions) permanece.
 */
import { requireSupportWrite } from "@/lib/impersonate/support";
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { conectarApi4com, desconectarApi4com } from "@/lib/channels/api4com/connect";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const SAFE_COLUMNS =
  "organization_id, domain, account_email, status, last_webhook_at, created_by, created_at, updated_at";

const postSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(200),
  domain: z.string().trim().min(1).max(255),
});

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "api4com_connections" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("api4com_connections_safe")
    .select(SAFE_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (error) return fail("internal_error", "Erro ao consultar a conexão api4com.", 500, { requestId });
  return ok(data ?? null, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const acompanhamentoNegado = await requireSupportWrite();
  if (acompanhamentoNegado) return acompanhamentoNegado;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "api4com_connections" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = postSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }
  const input = parsed.data;

  const resultado = await conectarApi4com({
    admin: createAdminClient(),
    orgId: activeOrg.orgId,
    userId: authUser.id,
    email: input.email,
    password: input.password,
    domain: input.domain,
  });

  if (!resultado.ok) {
    const mensagens: Record<typeof resultado.motivo, string> = {
      login_invalido: "Não consegui entrar na api4com com esse e-mail e senha.",
      cifragem: "Não consegui cifrar o token desta instalação. Confira a chave mestra do servidor.",
      banco: "Erro ao salvar a conexão.",
      webhook: "Conectado, mas não consegui registrar o webhook na api4com. Tente de novo em instantes.",
    };
    return fail("api4com_connect_failed", mensagens[resultado.motivo], 422, {
      requestId,
      details: { motivo: resultado.motivo, detalhe: resultado.detalhe },
    });
  }

  const { data: salvo } = await createAdminClient()
    .from("api4com_connections_safe")
    .select(SAFE_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .single();

  return ok(salvo, { requestId });
}

export async function DELETE(): Promise<Response> {
  const acompanhamentoNegado = await requireSupportWrite();
  if (acompanhamentoNegado) return acompanhamentoNegado;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "api4com_connections" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  await desconectarApi4com(createAdminClient(), activeOrg.orgId, authUser.id);
  return ok({ disconnected: true }, { requestId });
}
