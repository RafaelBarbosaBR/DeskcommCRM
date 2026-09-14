"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export type ManageTrackingSiteResult =
  | { ok: true; siteKey?: string }
  | {
      ok: false;
      error: "validation_failed" | "unauthenticated" | "forbidden_tenant" | "forbidden_role" | "mfa_required" | "erro_ao_gravar";
      details?: unknown;
    };

async function autorizarAdmin(): Promise<
  | { ok: true; orgId: string; userId: string }
  | { ok: false; result: ManageTrackingSiteResult }
> {
  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, result: { ok: false, error: "unauthenticated" } };
  if (supportWriteError(authUser.support)) return { ok: false, result: { ok: false, error: "forbidden_role" } };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, result: { ok: false, error: "forbidden_tenant" } };
  if (!authUser.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return { ok: false, result: { ok: false, error: "forbidden_role" } };
  }
  if (await mfaEmDivida()) return { ok: false, result: { ok: false, error: "mfa_required" } };
  return { ok: true, orgId: activeOrg.orgId, userId: authUser.id };
}

const criarSiteSchema = z.object({ name: z.string().trim().min(1).max(120) });

export async function createTrackingSite(
  input: z.infer<typeof criarSiteSchema>,
): Promise<ManageTrackingSiteResult> {
  const parsed = criarSiteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation_failed", details: parsed.error.flatten() };

  const auth = await autorizarAdmin();
  if (!auth.ok) return auth.result;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("tracking_sites")
    .insert({ organization_id: auth.orgId, name: parsed.data.name })
    .select("site_key")
    .maybeSingle();
  if (error || !data) return { ok: false, error: "erro_ao_gravar", details: error?.message };

  revalidatePath("/app/integrations/rastreamento");
  return { ok: true, siteKey: (data as { site_key: string }).site_key };
}

const addDominioSchema = z.object({
  trackingSiteId: z.string().uuid(),
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "domínio inválido"),
});

export async function addTrackingDomain(
  input: z.infer<typeof addDominioSchema>,
): Promise<ManageTrackingSiteResult> {
  const parsed = addDominioSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation_failed", details: parsed.error.flatten() };

  const auth = await autorizarAdmin();
  if (!auth.ok) return auth.result;

  const admin = createAdminClient();
  // Confere que o site é desta org antes de aceitar o domínio — path
  // traversal de tenant via id adivinhado.
  const { data: site } = await admin
    .from("tracking_sites")
    .select("id")
    .eq("id", parsed.data.trackingSiteId)
    .eq("organization_id", auth.orgId)
    .maybeSingle();
  if (!site) return { ok: false, error: "forbidden_tenant" };

  const { error } = await admin
    .from("tracking_domains")
    .upsert(
      { tracking_site_id: parsed.data.trackingSiteId, domain: parsed.data.domain },
      { onConflict: "tracking_site_id,domain" },
    );
  if (error) return { ok: false, error: "erro_ao_gravar", details: error.message };

  revalidatePath("/app/integrations/rastreamento");
  return { ok: true };
}

const removerDominioSchema = z.object({ trackingSiteId: z.string().uuid(), domain: z.string().trim().toLowerCase() });

export async function removeTrackingDomain(
  input: z.infer<typeof removerDominioSchema>,
): Promise<ManageTrackingSiteResult> {
  const parsed = removerDominioSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation_failed", details: parsed.error.flatten() };

  const auth = await autorizarAdmin();
  if (!auth.ok) return auth.result;

  const admin = createAdminClient();
  const { data: site } = await admin
    .from("tracking_sites")
    .select("id")
    .eq("id", parsed.data.trackingSiteId)
    .eq("organization_id", auth.orgId)
    .maybeSingle();
  if (!site) return { ok: false, error: "forbidden_tenant" };

  const { error } = await admin
    .from("tracking_domains")
    .delete()
    .eq("tracking_site_id", parsed.data.trackingSiteId)
    .eq("domain", parsed.data.domain);
  if (error) return { ok: false, error: "erro_ao_gravar", details: error.message };

  revalidatePath("/app/integrations/rastreamento");
  return { ok: true };
}
