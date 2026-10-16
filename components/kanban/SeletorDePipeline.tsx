"use client";

import Link from "next/link";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/hooks/i18n/useT";
import { CaretDown, Check } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

export interface PipelineDaLista {
  id: string;
  name: string;
}

/**
 * O menu que abre e fecha ao lado do título (issue 16/10): troca de pipeline
 * sem voltar para `/app/kanban` — cada item já é o link direto para o quadro
 * daquele pipeline, então a navegação não passa por um estado intermediário
 * de "selecionado, agora clique para abrir".
 *
 * A lista vem do SERVIDOR (`page.tsx`, mesma consulta aberta que a lista de
 * pipelines já faz), não de uma chamada cliente nova: `GET /api/v1/pipelines`
 * exige `manager+`, e este menu precisa aparecer para qualquer papel que já
 * está vendo um quadro.
 */
export function SeletorDePipeline({
  pipelineId,
  pipelines,
}: {
  pipelineId: string;
  pipelines: PipelineDaLista[];
}) {
  const t = useT();
  // Só um pipeline (ou nenhum outro): o menu não teria o que oferecer além do
  // que já está na tela — mostrar a seta mesmo assim ensinaria a ignorá-la.
  if (pipelines.length < 2) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("Trocar de pipeline")}
          data-testid="seletor-de-pipeline"
          className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-text-muted hover:bg-muted hover:text-text"
        >
          <CaretDown size={18} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        {pipelines.map((p) => (
          <DropdownMenuItem key={p.id} asChild>
            <Link
              href={`/app/pipelines/${p.id}`}
              className={cn(
                "flex items-center justify-between gap-2",
                p.id === pipelineId && "font-medium text-text",
              )}
            >
              <span className="min-w-0 truncate">{p.name}</span>
              {p.id === pipelineId && <Check size={14} className="shrink-0" aria-hidden />}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
