"use client";

import { useState, type ReactNode } from "react";

import { CaretDown } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

interface Props {
  titulo: string;
  children: ReactNode;
  /** Recolhida por padrão — só "Dados do negócio" fica sempre visível no dossiê. */
  defaultOpen?: boolean;
}

/** Seção recolhível genérica do dossiê do lead — mesmo padrão visual em todas. */
export function SecaoRecolhivel({ titulo, children, defaultOpen = false }: Props) {
  const [aberta, setAberta] = useState(defaultOpen);

  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={() => setAberta((v) => !v)}
        aria-expanded={aberta}
        className="flex w-full items-center justify-between py-3 text-left"
      >
        <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
          {titulo}
        </span>
        <CaretDown
          size={14}
          weight="bold"
          className={cn("shrink-0 text-text-subtle transition-transform", !aberta && "-rotate-90")}
          aria-hidden
        />
      </button>
      {aberta && <div className="pb-3">{children}</div>}
    </div>
  );
}
