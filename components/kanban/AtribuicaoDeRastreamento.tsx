"use client";

import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useAtribuicaoDeRastreamento } from "@/hooks/leads/useAtribuicaoDeRastreamento";
import type { ToquePosicionado } from "@/lib/leads/atribuicao-de-rastreamento";

function LinhaDoToque({ toque, idioma }: { toque: ToquePosicionado; idioma: string }) {
  const partes = [
    toque.utmSource && `utm_source=${toque.utmSource}`,
    toque.utmMedium && `utm_medium=${toque.utmMedium}`,
    toque.utmCampaign && `utm_campaign=${toque.utmCampaign}`,
    toque.fbclid && "fbclid",
    toque.gclid && "gclid",
    toque.gbraid && "gbraid",
    toque.wbraid && "wbraid",
  ].filter(Boolean);

  return (
    <div className="text-xs">
      <p className="text-text-muted">{new Date(toque.occurredAt).toLocaleString(idioma)}</p>
      {toque.url && <p className="truncate text-text">{toque.url}</p>}
      {partes.length > 0 ? (
        <p className="text-text-muted">{partes.join(" · ")}</p>
      ) : (
        <p className="text-text-muted">—</p>
      )}
    </div>
  );
}

/**
 * Item 4b do pedido: SÓ-LEITURA, nunca editado, nunca sobrescrito pelo bloco
 * manual de UTM. Contato sem nenhum touchpoint mostra explicitamente "sem
 * tracking (cadastro manual)" — nunca inventa valor.
 */
export function AtribuicaoDeRastreamento({ leadId }: { leadId: string }) {
  const t = useT();
  const idioma = useTagDeIdioma();
  const query = useAtribuicaoDeRastreamento(leadId);
  const [historicoAberto, setHistoricoAberto] = useState(false);

  if (query.isLoading) return null;
  const atribuicao = query.data;
  if (!atribuicao) return null;

  return (
    <div>
      {atribuicao.semTracking ? (
        <p className="text-xs text-text-muted">{t("Sem tracking (cadastro manual).")}</p>
      ) : (
        <div className="space-y-3">
          <div>
            <p className="text-[11px] font-medium uppercase text-text-muted">{t("Primeiro toque")}</p>
            <LinhaDoToque toque={atribuicao.primeiroToque} idioma={idioma} />
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase text-text-muted">{t("Último toque")}</p>
            <LinhaDoToque toque={atribuicao.ultimoToque} idioma={idioma} />
          </div>
          {atribuicao.historico.length > 2 && (
            <div>
              <button
                type="button"
                onClick={() => setHistoricoAberto((v) => !v)}
                className="text-xs text-text-muted underline-offset-2 hover:text-text hover:underline"
              >
                {historicoAberto
                  ? t("Ocultar histórico")
                  : `${t("Ver histórico completo")} (${atribuicao.historico.length})`}
              </button>
              {historicoAberto && (
                <div className="mt-2 max-h-48 space-y-2 overflow-y-auto">
                  {atribuicao.historico.map((toque, i) => (
                    <LinhaDoToque key={`${toque.occurredAt}-${i}`} toque={toque} idioma={idioma} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
