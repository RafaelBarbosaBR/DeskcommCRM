"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Listas salvas — um filtro de tag salvo, que vira atalho fixo no menu
 * lateral. `NAV_CATALOG` é estático (build-time); isto é dado por
 * organização, lido por `useSavedLeadViews` e renderizado numa seção à parte
 * em `components/shell/Sidebar.tsx`.
 */
export type SavedLeadViewResult =
  | { ok: true }
  | {
      ok: false;
      error: "validation_failed" | "unauthenticated" | "forbidden_tenant" | "forbidden_role" | "mfa_required" | "erro_ao_gravar";
      details?: unknown;
    };

async function autorizarManager(): Promise<
  { ok: true; orgId: string; userId: string } | { ok: false; result: SavedLeadViewResult }
> {
  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, result: { ok: false, error: "unauthenticated" } };
  if (supportWriteError(authUser.support)) return { ok: false, result: { ok: false, error: "forbidden_role" } };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, result: { ok: false, error: "forbidden_tenant" } };
  if (!authUser.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    return { ok: false, result: { ok: false, error: "forbidden_role" } };
  }
  if (await mfaEmDivida()) return { ok: false, result: { ok: false, error: "mfa_required" } };
  return { ok: true, orgId: activeOrg.orgId, userId: authUser.id };
}

const criarSchema = z.object({
  pipelineId: z.string().uuid(),
  label: z.string().trim().min(1).max(60),
  tag: z.string().trim().min(1).max(50),
});

export async function createSavedLeadView(
  input: z.infer<typeof criarSchema>,
): Promise<SavedLeadViewResult> {
  const parsed = criarSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation_failed", details: parsed.error.flatten() };

  const auth = await autorizarManager();
  if (!auth.ok) return auth.result;

  const admin = createAdminClient();
  const { error } = await admin.from("crm_saved_lead_views").insert({
    organization_id: auth.orgId,
    pipeline_id: parsed.data.pipelineId,
    label: parsed.data.label,
    tag: parsed.data.tag,
    created_by_user_id: auth.userId,
  });
  if (error) return { ok: false, error: "erro_ao_gravar", details: error.message };

  revalidatePath("/app", "layout");
  return { ok: true };
}

const removerSchema = z.object({ id: z.string().uuid() });

export async function deleteSavedLeadView(
  input: z.infer<typeof removerSchema>,
): Promise<SavedLeadViewResult> {
  const parsed = removerSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation_failed", details: parsed.error.flatten() };

  const auth = await autorizarManager();
  if (!auth.ok) return auth.result;

  const admin = createAdminClient();
  const { error } = await admin
    .from("crm_saved_lead_views")
    .delete()
    .eq("id", parsed.data.id)
    .eq("organization_id", auth.orgId);
  if (error) return { ok: false, error: "erro_ao_gravar", details: error.message };

  revalidatePath("/app", "layout");
  return { ok: true };
}
