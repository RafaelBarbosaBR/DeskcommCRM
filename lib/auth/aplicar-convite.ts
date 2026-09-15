import { cookies } from "next/headers";

import { audit } from "@/lib/audit";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { createAdminClient } from "@/lib/supabase/admin";
import type { InvitePayload } from "@/lib/auth/invite-token";

/**
 * O ATO de virar membro: grava o vínculo, audita e escolhe a organização ativa.
 *
 * Existe separado porque tem DOIS chamadores legítimos, e antes só havia um:
 *
 * - `app/actions/team/acceptInvite.ts` — quem já tinha conta e clicou no botão;
 * - `app/auth/confirm/route.ts` — quem acabou de confirmar o e-mail por um
 *   convite. Esse caminho conhecia o convite, tinha a sessão firmada e o e-mail
 *   provado pelo provedor de auth, e mesmo assim só redirecionava para uma tela
 *   com um botão. O vínculo é o que dá menu e organização; sem ele a pessoa
 *   entra num CRM vazio, e essa foi a experiência medida de dois convidados
 *   reais.
 *
 * Aqui NÃO se decide se o convite vale — quem decide é quem chama, e os dois
 * chamam `verifyInviteToken` antes (o segundo por dentro de
 * `decidirConviteDoSignup`, que ainda confere o e-mail contra o que o provedor
 * confirmou). Este módulo é o efeito, não a autoridade.
 */

export type ResultadoDoConvite =
  | { ok: true; membershipId: string; mudou: boolean }
  | { ok: false; motivo: "invalid_or_expired" | "internal_error" };

export async function aplicarConvite(params: {
  userId: string;
  payload: InvitePayload;
  requestId?: string | null;
}): Promise<ResultadoDoConvite> {
  const { userId, payload, requestId } = params;
  const admin = createAdminClient();

  // REVOGAR IMPEDE O ACEITE MESMO COM O LINK AINDA DENTRO DA VALIDADE.
  //
  // `verifyInviteToken` (chamado por quem invoca esta função) só confere a
  // ASSINATURA e o `exp` embutidos no próprio token — ele não sabe que
  // alguém, depois de emitir o link, mudou de ideia e revogou o convite pela
  // tela. `team_invites` (migration 0245) é a única fonte que sabe disso.
  //
  // Ausência de linha NÃO bloqueia: convite emitido antes da 0245 existir não
  // tem `team_invites` nenhuma, e tratar "não achei a linha" como "revogado"
  // quebraria todo link já em trânsito no dia do deploy.
  const { data: linhaDoConvite } = await admin
    .from("team_invites")
    .select("status")
    .eq("id", payload.invite_id)
    .maybeSingle();
  if ((linhaDoConvite as { status?: string } | null)?.status === "revoked") {
    return { ok: false, motivo: "invalid_or_expired" };
  }

  // Org, papel e convidador vêm EXCLUSIVAMENTE do token assinado; o usuário,
  // de quem chamou. Nada aqui vem de body de requisição.
  const { data: resultado, error } = await admin.rpc("fn_accept_team_invite", {
    p_interface_settings: payload.interface_settings ?? { preset: "completa" },
    p_user: userId,
    p_org: payload.organization_id,
    p_role: payload.role,
    p_invited_by: payload.invited_by ?? null,
    p_issued_at: payload.iat ? new Date(payload.iat * 1000).toISOString() : null,
    p_invited_at: new Date((payload.iat ?? payload.exp - 86400) * 1000).toISOString(),
  });

  if (error) {
    return {
      ok: false,
      // 42501 é a recusa da própria função (convite revogado ou posterior à
      // revogação) — não é falha de infraestrutura e não merece 500.
      motivo: error.code === "42501" ? "invalid_or_expired" : "internal_error",
    };
  }

  if (resultado.changed) {
    await audit({
      action: "member.accepted",
      actorUserId: userId,
      organizationId: payload.organization_id,
      resourceType: "membership",
      resourceId: resultado.id,
      metadata: { invite_id: payload.invite_id, role: payload.role },
      requestId: requestId ?? null,
    });
  }

  // Best-effort, e SEM `if (changed)`: mesmo num reaceite (link clicado duas
  // vezes, `changed: false`), a linha do convite precisa terminar como
  // "Aceito" na aba — não como "Pendente" para sempre, que é o que ficaria se
  // isto só rodasse na primeira vez. Ausência de linha (convite anterior à
  // 0245) não é erro: não há o que atualizar.
  await admin
    .from("team_invites")
    .update({ status: "accepted", accepted_at: new Date().toISOString() })
    .eq("id", payload.invite_id)
    .neq("status", "revoked");

  // Sem isto a pessoa entra sem organização escolhida e o app não sabe qual
  // mostrar — o mesmo motivo pelo qual o botão de aceite sempre gravou aqui.
  (await cookies()).set("active_org", payload.organization_id, {
    httpOnly: true,
    sameSite: "strict",
    secure: cookieSecure(),
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  return { ok: true, membershipId: resultado.id as string, mudou: Boolean(resultado.changed) };
}
