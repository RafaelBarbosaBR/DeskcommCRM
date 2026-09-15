/**
 * GET /api/v1/team/invites — os convites desta organização, com status.
 *
 * Antes desta rota (migration 0245) um convite pendente só existia dentro do
 * modal "Convidar membros" — sumia ao fechar. Não havia onde ver se um
 * convite foi enviado, se o e-mail saiu, se expirou ou foi ignorado.
 *
 * `accept_url` é reconstruído aqui, não armazenado: o token é
 * autossuficiente (HMAC sobre `{invite_id,email,org,role,exp,iat,...}`), e
 * `expires_at` na linha já carrega tudo que falta para refazê-lo. Só entra na
 * resposta quando o convite está genuinamente vivo — nenhuma linha nasce ou
 * vira `expired` sozinha (não há cron apagando prazo), então "vencido" é
 * calculado aqui comparando `expires_at` com agora, não lido do `status`
 * gravado. Um link reconstruído de um convite vencido falharia na hora do
 * clique (`verifyInviteToken` recusa `exp` no passado) — oferecer "copiar"
 * ali seria a mesma mentira que a tela existe para acabar.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { signInviteToken, INVITE_TTL_SECONDS, type InvitePayload } from "@/lib/auth/invite-token";
import { env } from "@/lib/env";
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
  invited_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  resent_count: number;
  last_resent_at: string | null;
  email_dispatched: boolean;
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "team_invites" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const db = await createClient();
  const { data, error } = await db
    .from("team_invites")
    .select(
      "id, email, role, interface_settings, status, invited_by, invited_at, expires_at, accepted_at, revoked_at, resent_count, last_resent_at, email_dispatched",
    )
    .eq("organization_id", org.orgId)
    .order("invited_at", { ascending: false });

  if (error) return fail("internal_error", error.message, 500, { requestId });

  const linhas = (data ?? []) as LinhaDoConvite[];
  const baseUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const agora = Date.now();

  return ok(
    linhas.map((l) => {
      const expEpoch = Math.floor(new Date(l.expires_at).getTime() / 1000);
      const vencido = expEpoch * 1000 < agora;
      // Ver o status gravado, mais o vencimento calculado — a tela não
      // precisa saber a regra, só o rótulo final.
      const statusEfetivo = l.status === "pending" && vencido ? "expired" : l.status;
      const acceptUrl =
        statusEfetivo === "pending"
          ? `${baseUrl}/team/accept-invite/${signInviteToken({
              invite_id: l.id,
              email: l.email,
              organization_id: org.orgId,
              role: l.role,
              interface_settings: l.interface_settings,
              invited_by: l.invited_by ?? undefined,
              exp: expEpoch,
              iat: expEpoch - INVITE_TTL_SECONDS,
            })}`
          : null;
      return { ...l, status: statusEfetivo, accept_url: acceptUrl };
    }),
    { requestId },
  );
}
