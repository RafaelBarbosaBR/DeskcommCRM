"use client";

import { useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";

/**
 * O comentário manual no topo da linha do tempo (16/10).
 *
 * Escreve em `crm_lead_activities` como `type: "note"` — o MESMO tipo que o
 * webhook de captação e a ferramenta da IA já gravam (`POST
 * /api/v1/leads/[id]/notes`). A linha nova chega pela assinatura realtime que
 * `useLeadTimeline` já mantém (INSERT em `crm_lead_activities` filtrado por
 * `lead_id`) — por isso não há `onSaved`/invalidação aqui: esperar o mesmo
 * caminho que qualquer outro escritor usa é a prova de que a nota entrou pela
 * porta certa, e duplicar a atualização aqui esconderia uma falha de
 * assinatura em vez de expor.
 */
export function LeadNoteComposer({ leadId }: { leadId: string }) {
  const t = useT();
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);

  async function enviar() {
    const text = texto.trim();
    if (!text || enviando) return;
    setEnviando(true);
    try {
      await apiClient.post(`/api/v1/leads/${leadId}/notes`, { text });
      setTexto("");
    } catch (erro) {
      if (erro instanceof ApiError) showApiError(erro);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="mb-3 flex flex-col gap-2">
      <Textarea
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        placeholder={t("Escreva um comentário sobre este negócio…")}
        className="min-h-[60px] text-sm"
        maxLength={4000}
        onKeyDown={(e) => {
          // Enter envia, Shift+Enter quebra linha — o mesmo atalho do
          // composer de notas da Inbox.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void enviar();
          }
        }}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="self-end"
        disabled={!texto.trim() || enviando}
        onClick={() => void enviar()}
      >
        {enviando ? t("Enviando…") : t("Comentar")}
      </Button>
    </div>
  );
}
