/**
 * Leitura da escolha da organização e o gate que toda rota de voz usa antes
 * de tocar `wacalls_sessions`/`voice_calls` — mesmo raciocínio de
 * `lib/agent-engine/guardrails/camadas-da-org.ts`, mas sem o degrau do
 * ambiente: aqui não há passado a preservar (ver `lib/voice/opt-in.ts`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fail } from "@/lib/api/wrappers";
import { chamadaDeVozLigada, instalacaoOfereceVoz } from "@/lib/voice/opt-in";

export interface EscolhaDaOrg {
  enabled: boolean;
  riscoAceitoEm: string | null;
  riscoAceitoPor: string | null;
}

const SEM_ESCOLHA: EscolhaDaOrg = { enabled: false, riscoAceitoEm: null, riscoAceitoPor: null };

/** Ausência de linha = não aceitou (default da própria tabela). Nunca lança. */
export async function lerEscolhaDaOrg(db: SupabaseClient, organizationId: string): Promise<EscolhaDaOrg> {
  const { data } = await db
    .from("org_voice_calls")
    .select("enabled, risco_aceito_em, risco_aceito_por")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!data) return SEM_ESCOLHA;
  return {
    enabled: data.enabled === true,
    riscoAceitoEm: data.risco_aceito_em,
    riscoAceitoPor: data.risco_aceito_por,
  };
}

/**
 * Guarda de rota: 503 quando a INSTALAÇÃO não oferece (não é escolha de
 * ninguém desta organização, então não é 403), 403 quando a ORGANIZAÇÃO não
 * aceitou. `null` = pode seguir.
 */
export async function exigirVozLigada(
  db: SupabaseClient,
  organizationId: string,
): Promise<Response | null> {
  if (!instalacaoOfereceVoz()) {
    return fail(
      "voice_not_configured",
      "Esta instalação não tem o serviço de chamada de voz configurado. Peça a quem administra o servidor para configurar o WaCalls.",
      503,
    );
  }
  const escolha = await lerEscolhaDaOrg(db, organizationId);
  if (!chamadaDeVozLigada(escolha.enabled)) {
    return fail(
      "voice_not_enabled",
      "A chamada de voz não está ligada para esta organização. Peça a um administrador para aceitar em Configurações → Segurança.",
      403,
    );
  }
  return null;
}
