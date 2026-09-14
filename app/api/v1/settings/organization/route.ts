/**
 * GET /api/v1/settings/organization — config leve da organização que telas
 * do dia a dia precisam sem re-navegar até Configurações. Hoje só
 * `whatsapp_default_country_code` (item 3 do pedido do dossiê do lead — o
 * gerador de link do WhatsApp nunca fixa um código de país no código).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("viewer", { requestId, resource: "organizations" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organizations")
    .select("whatsapp_default_country_code")
    .eq("id", authz.org.orgId)
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(
    { whatsapp_default_country_code: data?.whatsapp_default_country_code ?? "55" },
    { requestId },
  );
}
