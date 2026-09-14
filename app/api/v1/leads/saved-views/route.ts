/**
 * GET /api/v1/leads/saved-views — as listas salvas da org (atalho de tag no
 * sidebar). `NAV_CATALOG` é estático; isto é o que alimenta a seção dinâmica
 * em `components/shell/Sidebar.tsx`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "crm_saved_lead_views" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("crm_saved_lead_views")
    .select("id, pipeline_id, label, tag, position")
    .eq("organization_id", authz.org.orgId)
    .order("position", { ascending: true });

  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}
