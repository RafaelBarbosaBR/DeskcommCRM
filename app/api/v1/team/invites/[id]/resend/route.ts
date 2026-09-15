/**
 * POST /api/v1/team/invites/[id]/resend — reemite o convite com o MESMO
 * `invite_id`, um prazo novo, e manda o e-mail de novo.
 *
 * ═══ POR QUE O MESMO invite_id ═══
 *
 * Trocar o id criaria um SEGUNDO convite paralelo ao primeiro — os dois
 * válidos ao mesmo tempo, e revogar um não revogaria o outro. Reenviar é a
 * MESMA intenção de convite, só com um prazo novo; o link antigo (se ainda
 * não venceu) continua funcionando também — reenviar não invalida o que já
 * foi mandado, só garante que existe um caminho fresco.
 *
 * ═══ REQUER papel, NÃO REQUER estar "vivo" ═══
 *
 * Só recusa `accepted`/`revoked` — os dois são desfechos definitivos que
 * reenviar não desfaz (aceitar de novo não existe; revogado precisa ser
 * religado pela tela de opt-in, não por um reenvio). Um convite vencido
 * (`pending` com `expires_at` no passado) é exatamente o caso comum que esta
 * rota existe para resolver.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { signInviteToken, INVITE_TTL_SECONDS, type InvitePayload } from "@/lib/auth/invite-token";
import { buildInviteEmail } from "@/lib/email/templates/invite";
import { sendEmail } from "@/lib/email/resend";
import { marcaDaSaida } from "@/lib/branding/saida";
import { env } from "@/lib/env";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import type { InterfaceSettings } from "@/lib/navigation/interface";

export const dynamic = "force-dynamic";

interface LinhaDoConvite {
  id: string;
  email: string;
  role: InvitePayload["role"];
  interface_settings: InterfaceSettings;
  status: "pending" | "accepted" | "expired" | "revoked";
  invited_by: string | null;
  resent_count: number;
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await params;

  const authz = await requireRole("admin", { requestId, resource: "team_invites" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const db = await createClient();
  const { data: linhaRaw } = await db
    .from("team_invites")
    .select("id, email, role, interface_settings, status, invited_by, resent_count")
    .eq("organization_id", org.orgId)
    .eq("id", id)
    .maybeSingle();
  const linha = linhaRaw as LinhaDoConvite | null;
  if (!linha) return fail("not_found", t("Convite não encontrado."), 404, { requestId });
  if (linha.status === "accepted") {
    return fail("convite_ja_aceito", t("Este convite já foi aceito."), 422, { requestId });
  }
  if (linha.status === "revoked") {
    return fail(
      "convite_revogado",
      t("Este convite foi revogado. Emita um convite novo em vez de reenviar este."),
      422,
      { requestId },
    );
  }

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + INVITE_TTL_SECONDS;
  const token = signInviteToken({
    invite_id: linha.id,
    email: linha.email,
    organization_id: org.orgId,
    role: linha.role,
    interface_settings: linha.interface_settings,
    invited_by: linha.invited_by ?? undefined,
    exp,
    iat,
  });
  const acceptUrl = `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/team/accept-invite/${token}`;

  let dispatched = false;
  try {
    const marca = await marcaDaSaida(org.orgId);
    const message = buildInviteEmail({
      inviterName: user.full_name ?? user.email ?? "Um colega",
      orgName: org.name,
      acceptUrl,
      role: linha.role,
      expiresAt: new Date(exp * 1000),
      marca,
    });
    const result = await sendEmail({
      to: linha.email,
      ...message,
      fromName: marca.nome,
      tags: [
        { name: "kind", value: "team_invite_resend" },
        { name: "org", value: org.orgId },
      ],
    });
    dispatched = result.ok;
  } catch {
    /* A superfície de recuperação é o link devolvido abaixo — igual ao emissor original. */
  }

  const { error } = await db
    .from("team_invites")
    .update({
      status: "pending",
      expires_at: new Date(exp * 1000).toISOString(),
      resent_count: linha.resent_count + 1,
      last_resent_at: new Date().toISOString(),
      email_dispatched: dispatched,
    })
    .eq("id", linha.id)
    .eq("organization_id", org.orgId);
  if (error) return fail("save_failed", error.message, 500, { requestId });

  await audit({
    action: "member.invite_resent",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "membership",
    resourceId: linha.id,
    requestId,
    metadata: { email: linha.email, email_dispatched: dispatched },
  });

  return ok(
    { email: linha.email, expires_at: new Date(exp * 1000).toISOString(), email_dispatched: dispatched, accept_url: acceptUrl },
    { requestId },
  );
}
