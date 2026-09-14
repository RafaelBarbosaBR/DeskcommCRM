"use client";

import { useState } from "react";
import { toast } from "sonner";

import { useT } from "@/hooks/i18n/useT";
import { useAddNote } from "@/hooks/leads/useAddNote";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const LIMITE = 1000;

/** Item 5 do pedido: texto livre, autor e data automáticos (colunas da timeline). */
export function NotaComposer({ leadId }: { leadId: string }) {
  const t = useT();
  const [texto, setTexto] = useState("");
  const mutation = useAddNote(leadId);

  function enviar() {
    const corpo = texto.trim();
    if (!corpo) return;
    mutation.mutate(corpo, {
      onSuccess: () => setTexto(""),
      onError: () => toast.error(t("Não consegui salvar a nota.")),
    });
  }

  return (
    <div className="mb-2 space-y-1.5">
      <Textarea
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        maxLength={LIMITE}
        rows={2}
        placeholder={t("Escreva uma anotação sobre este negócio…")}
        className="text-xs"
      />
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-text-muted">{texto.length}/{LIMITE}</span>
        <Button
          type="button"
          size="sm"
          onClick={enviar}
          disabled={mutation.isPending || !texto.trim()}
        >
          {mutation.isPending ? t("Salvando…") : t("Adicionar nota")}
        </Button>
      </div>
    </div>
  );
}
