/**
 * GET /api/v1/telefonia/api4com/mapeamentos — cada membro da org ativa + o
 *     ramal api4com mapeado (ou `null`), pra tela de Configurações > Telefonia
 *     escolher por pessoa. Mesmo padrão de enriquecimento de `GET /api/v1/team`
 *     (membership + `auth.admin.getUserById`).
 * PUT /api/v1/telefonia/api4com/mapeamentos — grava o ramal de UM usuário
 *     (admin). Body: { user_id, extension }. `extension: null` remove o
 *     mapeamento.
 */
import { requireSupportWrite } from "@/lib/impersonate/support";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface MembroDto {
  user_id: string;
  email: string | null;
  full_name: string | null;
  extension: string | null;
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "api4com_extensions" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data: membros, error: membrosErr } = await supabase
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", activeOrg.orgId)
    .is("revoked_at", null)
    .order("created_at", { ascending: true });
  if (membrosErr) return fail("internal_error", membrosErr.message, 500, { requestId });

  const admin = createAdminClient();
  const { data: mapeamentos } = await admin
    .from("api4com_extensions")
    .select("user_id, extension")
    .eq("organization_id", activeOrg.orgId);
  const porUsuario = new Map((mapeamentos ?? []).map((m) => [m.user_id as string, m.extension as string]));

  const dto: MembroDto[] = await Promise.all(
    (membros ?? []).map(async (m) => {
      const { data: userRes } = await admin.auth.admin.getUserById(m.user_id as string);
      const u = userRes?.user;
      return {
        user_id: m.user_id as string,
        email: u?.email ?? null,
        full_name: (u?.user_metadata?.full_name as string | undefined) ?? null,
        extension: porUsuario.get(m.user_id as string) ?? null,
      };
    }),
  );

  return ok(dto, { requestId });
}

const putSchema = z.object({
  user_id: z.string().uuid(),
  extension: z.string().trim().min(1).max(50).nullable(),
});

export async function PUT(req: NextRequest): Promise<Response> {
  const acompanhamentoNegado = await requireSupportWrite();
  if (acompanhamentoNegado) return acompanhamentoNegado;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "api4com_extensions" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = putSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }
  const input = parsed.data;

  // O alvo PRECISA ser membro ativo desta organização — sem este filtro, um
  // admin mapearia um ramal pra um user_id de QUALQUER lugar (ids de usuário
  // não são segredo), e a próxima chamada discada em nome dele sairia com o
  // ramal de outra pessoa.
  const supabase = await createClient();
  const { data: membro } = await supabase
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", activeOrg.orgId)
    .eq("user_id", input.user_id)
    .is("revoked_at", null)
    .maybeSingle();
  if (!membro) {
    return fail("not_found", "Este usuário não é membro ativo desta organização.", 404, { requestId });
  }

  const admin = createAdminClient();
  if (input.extension === null) {
    const { error } = await admin
      .from("api4com_extensions")
      .delete()
      .eq("organization_id", activeOrg.orgId)
      .eq("user_id", input.user_id);
    if (error) return fail("internal_error", error.message, 500, { requestId });
  } else {
    const { error } = await admin.from("api4com_extensions").upsert(
      {
        organization_id: activeOrg.orgId,
        user_id: input.user_id,
        extension: input.extension,
      },
      { onConflict: "organization_id,user_id" },
    );
    if (error) return fail("internal_error", error.message, 500, { requestId });
  }

  await audit({
    action: "api4com.extension_mapped",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "api4com_extensions",
    resourceId: input.user_id,
    requestId,
    metadata: { target_user_id: input.user_id, extension: input.extension },
  });

  return ok({ saved: true }, { requestId });
}
