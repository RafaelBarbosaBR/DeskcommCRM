"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { addTrackingDomain, createTrackingSite, removeTrackingDomain } from "@/app/actions/settings/manageTrackingSite";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import type { TrackingSiteComDominios } from "@/lib/rastreamento/estado-da-conexao";

export function SitesDeRastreamento({
  sites,
  idioma,
}: {
  sites: TrackingSiteComDominios[];
  idioma: Idioma;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [nomeNovoSite, setNomeNovoSite] = useState("");
  const [novoDominio, setNovoDominio] = useState<Record<string, string>>({});

  function criarSite() {
    if (!nomeNovoSite.trim()) return;
    startTransition(async () => {
      const resultado = await createTrackingSite({ name: nomeNovoSite.trim() });
      if (resultado.ok) {
        setNomeNovoSite("");
        toast.success(t("Site criado."));
        router.refresh();
        return;
      }
      toast.error(t("Não consegui criar agora."));
    });
  }

  function adicionarDominio(trackingSiteId: string) {
    const domain = (novoDominio[trackingSiteId] ?? "").trim();
    if (!domain) return;
    startTransition(async () => {
      const resultado = await addTrackingDomain({ trackingSiteId, domain });
      if (resultado.ok) {
        setNovoDominio((s) => ({ ...s, [trackingSiteId]: "" }));
        router.refresh();
        return;
      }
      toast.error(t("Domínio inválido."));
    });
  }

  function removerDominio(trackingSiteId: string, domain: string) {
    startTransition(async () => {
      const resultado = await removeTrackingDomain({ trackingSiteId, domain });
      if (resultado.ok) router.refresh();
    });
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{t("Sites")}</h2>
      <p className="text-sm text-muted-foreground">
        {t("Cada site tem uma chave pública própria. Cole o snippet abaixo antes do fechamento de <head> — um script só, o mesmo em toda página.")}
      </p>

      {sites.map((site) => {
        const origem = process.env.NEXT_PUBLIC_APP_URL ?? "";
        const snippet = `<script src="${origem}/api/v1/track/t.js" data-site="${site.siteKey}" async></script>`;
        return (
          <Card key={site.id} className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{site.name}</span>
              {!site.isActive && (
                <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t("inativo")}</span>
              )}
            </div>
            <pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-xs">{snippet}</pre>
            <div className="mt-3 flex flex-col gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                {t("Domínios permitidos (opcional — sem nenhum, qualquer origem é aceita)")}
              </span>
              <div className="flex flex-wrap gap-2">
                {site.domains.map((d) => (
                  <span key={d} className="flex items-center gap-1 rounded bg-muted px-2 py-1 text-xs">
                    {d}
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => removerDominio(site.id, d)}
                      disabled={isPending}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="meusite.com.br"
                  value={novoDominio[site.id] ?? ""}
                  onChange={(e) => setNovoDominio((s) => ({ ...s, [site.id]: e.target.value }))}
                  className="max-w-xs"
                />
                <Button type="button" variant="secondary" onClick={() => adicionarDominio(site.id)} disabled={isPending}>
                  {t("Adicionar")}
                </Button>
              </div>
            </div>
          </Card>
        );
      })}

      <div className="flex gap-2">
        <Input
          placeholder={t("Nome do site (ex.: Site institucional)")}
          value={nomeNovoSite}
          onChange={(e) => setNomeNovoSite(e.target.value)}
          className="max-w-sm"
        />
        <Button type="button" onClick={criarSite} disabled={isPending || !nomeNovoSite.trim()}>
          {t("Novo site")}
        </Button>
      </div>
    </section>
  );
}
