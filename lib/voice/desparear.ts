/**
 * Desparear a sessão WaCalls da organização — mesmo desenho de arquivamento
 * que `channel_sessions.archived_at` já usa (soft, nunca DELETE: histórico de
 * `voice_calls` referencia a sessão pelo `organization_id`, não por FK, então
 * não há órfão a temer, mas apagar a linha perderia `wacalls_paired_at`/
 * `wacalls_jid` que a auditoria pode querer depois).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import { getWacallsClient } from "@/lib/wacalls/client";

export type ResultadoDoDesparear = { ok: true } | { ok: false; erro: string };

/**
 * A remoção REMOTA (apagar as credenciais no servidor WaCalls) é best-effort:
 * se o serviço estiver fora do ar, ainda assim arquivamos localmente — deixar
 * o botão "desparear" preso a um terceiro fora do ar seria pior que uma
 * credencial órfã no lado deles, que expira/é substituída no próximo
 * pareamento de qualquer forma.
 */
export async function despareaVoz(db: SupabaseClient, organizationId: string): Promise<ResultadoDoDesparear> {
  const client = getWacallsClient();
  if (client) {
    const { data: sessao } = await db
      .from("wacalls_sessions")
      .select("wacalls_session_id")
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (sessao?.wacalls_session_id) {
      try {
        await client.deleteSession(sessao.wacalls_session_id);
      } catch (err) {
        logger.warn("[voice] não consegui remover a sessão no servidor WaCalls; arquivando só localmente", {
          organizationId,
          erro: err instanceof Error ? err.message : "unknown",
        });
      }
    }
  }

  const { error } = await db
    .from("wacalls_sessions")
    .update({ archived_at: new Date().toISOString(), status: "STOPPED" })
    .eq("organization_id", organizationId)
    .is("archived_at", null);
  if (error) return { ok: false, erro: "Não consegui desparear agora." };
  return { ok: true };
}
