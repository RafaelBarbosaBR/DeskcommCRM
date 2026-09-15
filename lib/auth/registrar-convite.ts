/**
 * Grava o metadado do convite recém-emitido em `team_invites` — a metade que
 * `issueInvite()`/`sendOnboardingInvites.ts` não faziam antes da migration
 * 0245: o token (assinatura HMAC) já provava tudo sozinho, sem precisar de
 * linha nenhuma, mas isso também significava não haver onde VER os convites
 * mandados, nem como revogar um link antes do TTL de 24h esgotar sozinho.
 *
 * Best-effort de propósito: o convite (token + e-mail) já foi emitido quando
 * esta função roda. Uma falha aqui tira o convite da aba "Convites" — não
 * impede ninguém de aceitar o link que já recebeu. Derrubar o fluxo inteiro
 * por causa de uma tabela de auditoria seria pior que a própria falha.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import type { InterfaceSettings } from "@/lib/navigation/interface";

export interface DadosDoConviteEmitido {
  inviteId: string;
  organizationId: string;
  email: string;
  role: "viewer" | "agent" | "manager" | "admin";
  interfaceSettings: InterfaceSettings;
  invitedBy: string;
  expiresAt: Date;
  emailDispatched: boolean;
}

export async function registrarConvite(dados: DadosDoConviteEmitido): Promise<void> {
  // try/catch em volta do MÉTODO INTEIRO, não só do `await`: `createAdminClient()`
  // pode lançar de forma síncrona (service role não configurado, por exemplo
  // em ambiente de teste que nunca chega a precisar desta tabela) — sem isto,
  // "best-effort" valeria só para a metade assíncrona do erro, e o convite
  // (token + e-mail, já emitidos quando esta função roda) quebraria por causa
  // de uma tabela de auditoria.
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("team_invites").insert({
      id: dados.inviteId,
      organization_id: dados.organizationId,
      email: dados.email,
      role: dados.role,
      interface_settings: dados.interfaceSettings,
      invited_by: dados.invitedBy,
      expires_at: dados.expiresAt.toISOString(),
      email_dispatched: dados.emailDispatched,
    });
    if (error) {
      logger.warn("team_invites: não consegui registrar o convite emitido", {
        invite_id: dados.inviteId,
        organization_id: dados.organizationId,
        error: error.message,
      });
    }
  } catch (err) {
    logger.warn("team_invites: registrar o convite emitido lançou", {
      invite_id: dados.inviteId,
      organization_id: dados.organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
