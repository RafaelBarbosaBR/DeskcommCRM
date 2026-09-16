import { notFound } from "next/navigation";

import { loadAuthUser } from "@/lib/auth/server";
import { platformMetaAppStatus } from "@/lib/channels/meta/platform-app";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { createAdminClient } from "@/lib/supabase/admin";

import { FormularioDoAppDaMeta } from "./_form";

export const metadata = { title: "App da Meta da instalação" };
export const dynamic = "force-dynamic";

/**
 * A tela onde o dono da instalação cadastra o App da Meta (WhatsApp Cloud
 * API) — irmã de `/admin/google`, mesmo argumento (config de PLATAFORMA, não
 * de organização): um App Secret vale para TODAS as WABAs de TODAS as
 * organizações desta instalação, então só quem administra a plataforma pode
 * trocá-lo.
 *
 * ⚠️ NENHUM DOS DOIS SEGREDOS VOLTA. `platformMetaAppStatus` só devolve
 * `configured`/`source` — nunca o App Secret decifrado, nunca o
 * `webhook_verify_token` gravado. O verify token só é visto uma vez, no
 * instante em que `regenerateMetaVerifyToken` o gera.
 */
export default async function Page() {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();

  const status = await platformMetaAppStatus(createAdminClient());

  return (
    <FormularioDoAppDaMeta
      appSecretConfigurado={status.appSecret.configured}
      appSecretFonte={status.appSecret.source}
      verifyTokenConfigurado={status.webhookVerifyToken.configured}
      verifyTokenFonte={status.webhookVerifyToken.source}
      atualizadoEm={
        status.updatedAt
          ? new Date(status.updatedAt).toLocaleString(tagDeIdioma(usuario.idioma), {
              // Fuso fixo: não há organização resolvida nesta tela de onde
              // tirar um, e formatar no cliente faria o HTML servido e a
              // hidratação divergirem — mesma decisão de `/admin/google`.
              timeZone: "America/Sao_Paulo",
              dateStyle: "short",
              timeStyle: "short",
            })
          : null
      }
    />
  );
}
