import Link from "next/link";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { lerEstadoDosProviders, lerTrackingSites } from "@/lib/rastreamento/estado-da-conexao";
import { createAdminClient } from "@/lib/supabase/admin";
import { FormularioDeMeta } from "./_form-meta";
import { FormularioDeGa4 } from "./_form-ga4";
import { FormularioDeGoogleAds } from "./_form-google-ads";
import { SitesDeRastreamento } from "./_sites";

export const metadata = { title: "Rastreamento" };
export const dynamic = "force-dynamic";

export default async function RastreamentoPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }

  const admin = createAdminClient();
  const [estados, sites] = await Promise.all([
    lerEstadoDosProviders(admin, activeOrg.orgId),
    lerTrackingSites(admin, activeOrg.orgId),
  ]);
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Rastreamento")}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(
            "Um script instalável no site, atribuição de anúncio (UTM, fbclid, gclid) e conversão automática pra Meta, GA4 e Google Ads quando um negócio avança no pipeline.",
          )}
        </p>
      </header>

      <SitesDeRastreamento sites={sites} idioma={idioma} />

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">{t("Providers")}</h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <FormularioDeMeta estado={estados.META} idioma={idioma} />
          <FormularioDeGa4 estado={estados.GA4} idioma={idioma} />
          <FormularioDeGoogleAds estado={estados.GOOGLE_ADS} idioma={idioma} />
        </div>
      </section>

      <section className="flex items-center justify-between rounded-md border p-4">
        <div>
          <h2 className="text-sm font-semibold">{t("Auditoria de rastreamento")}</h2>
          <p className="text-sm text-muted-foreground">
            {t(
              "O que aconteceu com cada evento, da captura à resposta real de cada plataforma — fila de retry, log bruto por tentativa e ações administrativas.",
            )}
          </p>
        </div>
        <Link
          href="/app/integrations/rastreamento/auditoria"
          className="shrink-0 rounded-md border border-accent px-3 py-1.5 text-sm font-medium text-accent hover:bg-accent/10"
        >
          {t("Ver auditoria completa")}
        </Link>
      </section>
    </div>
  );
}
