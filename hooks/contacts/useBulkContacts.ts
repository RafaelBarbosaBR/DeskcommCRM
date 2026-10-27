"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

/** As ações em lote da tela de Contatos — o mesmo discriminante da rota (#2484, F3). */
export type AcaoEmLoteDeContatos =
  | { action: "tag"; op: "add" | "remove"; tag: string }
  | { action: "carteira"; dono_user_id: string | null; origem?: "manual" }
  | { action: "custom-field"; chave: string; valor: string | number | boolean | null };

/** Uma linha do relatório por item, como a rota devolve. */
export interface ResultadoDoItem {
  id: string;
  feito: boolean;
  codigo?: string;
  motivo?: string;
  request_id?: string;
}

/** O relatório inteiro da chamada em lote. */
export interface RelatorioDoLote {
  acao: string;
  teto: number;
  total: number;
  feitos: number;
  recusados: number;
  resultados: ResultadoDoItem[];
}

interface BulkArgs {
  ids: string[];
}

/**
 * A camada de lote dos contatos: UMA chamada para N contatos (#2484, F3).
 *
 * A rota é uma só (`POST /api/v1/contacts/bulk`); o hook espelha o
 * discriminante dela. Nada de permissão, organização ou auditoria aqui — cada
 * item é resolvido pelo caminho individual (o PATCH da ficha ou o da carteira),
 * e o que volta é o relatório por item.
 *
 * O toast de sucesso CONTA os dois lados: um lote pela metade não é sucesso nem
 * erro, e quem clicou precisa saber quantos contatos sobraram por fazer — com
 * o motivo de cada recusa, que a rota já manda traduzido.
 */
export function useBulkContacts() {
  const qc = useQueryClient();
  const t = useT();

  return useMutation({
    mutationFn: (args: BulkArgs & AcaoEmLoteDeContatos) =>
      apiClient.post<{ data: RelatorioDoLote }>("/api/v1/contacts/bulk", {
        ...args,
      }),
    onError: (err) => {
      // 403/422 da CHAMADA (sem permissão, acima do teto): o lote nem começou.
      showApiError(err);
    },
    onSuccess: (res) => {
      const r = res.data;
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["contact"] });

      const recusados = r.resultados.filter((x) => !x.feito);
      if (recusados.length === 0) {
        // Texto próprio dos contatos: "atualizadas"/"recusadas" são as chaves
        // das conversas (F1) e davam "2 contatos atualizadas".
        toast.success(
          r.feitos === 1 ? t("1 contato atualizado.") : `${r.feitos} ${t("contatos atualizados")}.`,
        );
        return;
      }
      // Número e palavra concordam: "1 atualizados, 1 recusados." foi medido na tela (#2913).
      const feitos = `${r.feitos} ${r.feitos === 1 ? t("atualizado") : t("atualizados")}`;
      const recusas = `${recusados.length} ${recusados.length === 1 ? t("recusado") : t("recusados")}`;
      toast.warning(`${feitos}, ${recusas}.`, {
        description: recusados.map((x) => x.motivo ?? x.codigo ?? t("Recusado.")).join(" · "),
      });
    },
  });
}
