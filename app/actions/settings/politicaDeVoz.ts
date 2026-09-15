"use server";

/**
 * LIGAR E DESLIGAR A CHAMADA DE VOZ PARA A ORGANIZAÇÃO — o segundo dos dois
 * eixos de desligado (o primeiro é a instalação oferecer o serviço, ver
 * `lib/voice/opt-in.ts`). Mesmo padrão de `app/actions/auth/politicaDeMfa.ts`
 * (`definirExigenciaDeMfa`): `admin`+ da própria org, sem bypass de service
 * role — a RLS de `org_voice_calls` já permite escrita a `admin`+ pelo client
 * de sessão (diferente de `organizations`, que só aceita platform_admin ali).
 */
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { supportWriteError } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { instalacaoOfereceVoz } from "@/lib/voice/opt-in";

export type ResultadoDaVoz = { ok: true } | { ok: false; erro: string };

export async function definirChamadaDeVoz(aceitar: boolean): Promise<ResultadoDaVoz> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, erro: "Sua sessão expirou. Entre de novo." };
  if (supportWriteError(user.support)) return { ok: false, erro: "Acompanhamento somente leitura ou encerrado." };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, erro: "Nenhuma empresa ativa." };
  if (org.role !== "admin") return { ok: false, erro: "Só um administrador pode mudar essa regra." };

  if (aceitar && !instalacaoOfereceVoz()) {
    return {
      ok: false,
      erro:
        "Esta instalação não tem o serviço de chamada de voz configurado. Peça a quem administra o servidor para configurá-lo.",
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("org_voice_calls").upsert({
    organization_id: org.orgId,
    enabled: aceitar,
    risco_aceito_em: aceitar ? new Date().toISOString() : null,
    risco_aceito_por: aceitar ? user.id : null,
  });
  if (error) return { ok: false, erro: "Não consegui salvar essa mudança agora." };

  await audit({
    action: aceitar ? "voice.enabled" : "voice.disabled",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
  });

  revalidatePath("/app/settings/security");
  return { ok: true };
}
