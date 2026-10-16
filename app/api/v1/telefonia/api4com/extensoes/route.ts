/**
 * GET /api/v1/telefonia/api4com/extensoes — ramais JÁ EXISTENTES na conta
 * api4com conectada (admin), pro dropdown de mapeamento por usuário. Não cria
 * ramal nenhum — M1 só lista o que o cliente já tem lá (ver `.changes/`,
 * decisão deliberada de não provisionar recurso cobrável sem pedido
 * explícito).
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { Api4comError, api4comListExtensions } from "@/lib/channels/api4com/client";
import { api4comCredsForOrg } from "@/lib/channels/api4com/credentials";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "api4com_connections" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const admin = createAdminClient();
  const creds = await api4comCredsForOrg(admin, activeOrg.orgId);
  if (!creds) {
    return fail("api4com_not_connected", "Conecte a conta api4com antes de mapear ramais.", 422, { requestId });
  }

  try {
    const extensoes = await api4comListExtensions(creds.accessToken);
    return ok(extensoes, { requestId });
  } catch (err) {
    const status = err instanceof Api4comError ? err.status : 502;
    return fail(
      "api4com_extensions_failed",
      "Não consegui listar os ramais na api4com.",
      status >= 400 && status < 500 ? 422 : 502,
      { requestId },
    );
  }
}
