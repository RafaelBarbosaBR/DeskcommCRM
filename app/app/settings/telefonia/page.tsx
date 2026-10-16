import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { TelefoniaSettingsClient, type Api4comConnectionRow } from "./_client";

export const dynamic = "force-dynamic";

const SAFE_COLUMNS =
  "organization_id, domain, account_email, status, last_webhook_at, created_by, created_at, updated_at";

export default async function TelefoniaSettingsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("api4com_connections_safe")
    .select(SAFE_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  const canWrite = ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <TelefoniaSettingsClient
        initialData={(data as Api4comConnectionRow | null) ?? null}
        canWrite={canWrite}
      />
    </div>
  );
}
