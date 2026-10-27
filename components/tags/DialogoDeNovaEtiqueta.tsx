"use client";
/**
 * Caixa de diálogo da sugestão de etiqueta (#2789).
 *
 * ─── Por que existe ─────────────────────────────────────────────────────────
 * Nos editores, o nome DIGITADO já nasce colorido (#2718): o operador escolhe o
 * tom no gatilho 🎨 e só então clica "+". A sugestão do vocabulário escapava
 * desse caminho — o chip chamava `add(tag)` direto, com `cor` ainda `null`, e a
 * etiqueta nascia sem cor sem que a paleta aparecesse. A queixa é exatamente
 * essa: "clico e vai direto, sem cor".
 *
 * Aqui o clique abre ISTO: a etiqueta em prévia, a mesma paleta de oito tons do
 * painel de Settings (PALETA_DE_ETIQUETAS, cada um com nome em NOME_DO_TOM —
 * escolher por "Âmbar" chega ao mesmo lugar que escolher pelo círculo, e o
 * leitor de tela anuncia o tom) e as ações confirmar/cancelar. Cancelar não
 * cria nada.
 *
 * ─── Por que pré-marca o tom que já existe ──────────────────────────────────
 * A sugestão pode já ter cor no vocabulário da organização (é dela que vem o
 * ponto no chip). Abrir a paleta como se ela não tivesse cor faria "Confirmar"
 * apagar o que estava lá — a mesma pegadinha que a #2771 corrigiu ao lado de
 * quem já está no contato.
 *
 * ─── Quem não vê isto ───────────────────────────────────────────────────────
 * O editor só monta o diálogo para quem a rota não vai recusar: `POST
 * /api/v1/tags/vocabulario` exige `requireRole("manager")` + MFA. Para `agent`
 * o clique continua direto, como antes — sem erro e sem ruído. É a mesma régua
 * do `SeletorDeCorDaEtiqueta`: a tela não oferece o que a escrita recusa.
 */
import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { NOME_DO_TOM, PALETA_DE_ETIQUETAS } from "@/lib/tags/cor-da-etiqueta";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";

interface Props {
  /** Nome da sugestão escolhida — o diálogo só é montado com ela (`null` não monta). */
  tag: string;
  /** Tom já gravado no vocabulário, que vem pré-marcado. */
  corInicial: string | null;
  onFechar: () => void;
  /** `null` = "Sem cor" escolhido de propósito. */
  onConfirmar: (cor: string | null) => void;
  disabled?: boolean;
}

export function DialogoDeNovaEtiqueta({
  tag,
  corInicial,
  onFechar,
  onConfirmar,
  disabled,
}: Props) {
  const t = useT();
  const [tom, setTom] = useState<string | null>(corInicial);

  return (
    <Dialog
      open
      onOpenChange={(aberto) => {
        if (!aberto) onFechar();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Adicionar tag")}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{t("Prévia:")}</span>
            {/* `null` força a prévia sem cor; `undefined` cairia no tom do vocabulário. */}
            <ChipDeEtiqueta tag={tag} cor={tom} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {PALETA_DE_ETIQUETAS.map((tomDaPaleta) => (
              <button
                key={tomDaPaleta}
                type="button"
                onClick={() => setTom(tomDaPaleta)}
                disabled={disabled}
                aria-pressed={tom === tomDaPaleta}
                // O nome do tom é o rótulo acessível; a cor é reforço — a mesma
                // redundância não-cromática do painel de Settings (#1271/#2373).
                aria-label={t(NOME_DO_TOM[tomDaPaleta] ?? tomDaPaleta)}
                title={tomDaPaleta}
                className={cn(
                  "size-7 rounded-full border-2 transition-transform disabled:opacity-50",
                  tom === tomDaPaleta
                    ? "border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                    : "border-transparent hover:scale-110",
                )}
                style={{ backgroundColor: tomDaPaleta }}
              />
            ))}
            <Button
              type="button"
              size="sm"
              variant={tom === null ? "default" : "outline"}
              aria-pressed={tom === null}
              disabled={disabled}
              onClick={() => setTom(null)}
            >
              {t("Sem cor")}
            </Button>
          </div>
        </div>

        <DialogFooter className="pt-2">
          <Button type="button" size="sm" variant="outline" onClick={onFechar} disabled={disabled}>
            {t("Cancelar")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => onConfirmar(tom)}
            disabled={disabled}
            aria-label={t("Adicionar tag")}
          >
            {t("Adicionar tag")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
