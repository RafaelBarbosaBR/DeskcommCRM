"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiClient } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { showApiError } from "@/components/feedback/ApiErrorToast";

interface Excecao {
  id: string;
  exception_date: string;
  is_unavailable: boolean;
  start_minute: number;
  end_minute: number;
  reason: string | null;
}

/**
 * FECHAR UM DIA (feriado, férias) — ou abrir um excepcionalmente.
 *
 * O motor (`janelasDoDia`, lib/agenda/horarios-livres.ts) e a tabela
 * (`calendar_availability_exceptions`, migration 0177) já existiam; faltava
 * só a porta. `start_minute`/`end_minute` ficam fixos em 0..1440 (dia
 * inteiro) nesta tela — a exceção de FAIXA PARCIAL do dia (abrir só de
 * manhã, por exemplo) continua possível pela API, só não tem controle aqui
 * ainda: o caso que motivou o item é o dia inteiro fechado.
 */
export function FechamentosDaAgenda() {
  const t = useT();
  const qc = useQueryClient();
  const [data, setData] = useState("");
  const [motivo, setMotivo] = useState("");

  const query = useQuery({
    queryKey: ["agenda", "excecoes"],
    queryFn: async () => (await apiClient.get<{ data: Excecao[] }>("/api/v1/agenda/excecoes")).data,
  });

  const criar = useMutation({
    mutationFn: () =>
      apiClient.post("/api/v1/agenda/excecoes", {
        exception_date: data,
        is_unavailable: true,
        reason: motivo.trim() || undefined,
      }),
    onSuccess: () => {
      setData("");
      setMotivo("");
      void qc.invalidateQueries({ queryKey: ["agenda", "excecoes"] });
    },
    onError: showApiError,
  });

  const remover = useMutation({
    mutationFn: (id: string) => apiClient.delete("/api/v1/agenda/excecoes", { id }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["agenda", "excecoes"] }),
    onError: showApiError,
  });

  const excecoes = query.data ?? [];

  return (
    <section className="space-y-3 rounded-xl border p-4" data-testid="fechamentos-da-agenda">
      <h2 className="font-semibold">{t("Fechar um dia (feriado, férias)")}</h2>
      <p className="text-sm text-text-muted">
        {t(
          "Nos dias abaixo, sua agenda não oferece horário nenhum — mesmo que a jornada semanal diga que sim.",
        )}
      </p>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (data) criar.mutate();
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          {t("Data")}
          <input
            type="date"
            required
            aria-label={t("Data")}
            className="rounded-md border p-2"
            value={data}
            onChange={(e) => setData(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          {t("Motivo (opcional)")}
          <input
            type="text"
            maxLength={200}
            aria-label={t("Motivo (opcional)")}
            placeholder={t("Feriado, férias…")}
            className="rounded-md border p-2"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
          />
        </label>
        <Button type="submit" disabled={!data || criar.isPending}>
          {t("Fechar este dia")}
        </Button>
      </form>

      {query.isError ? (
        <Button variant="outline" onClick={() => void query.refetch()}>
          {t("Tentar novamente")}
        </Button>
      ) : excecoes.length === 0 ? (
        <p className="text-sm text-text-muted">{t("Nenhum dia fechado.")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {excecoes.map((ex) => (
            <li
              key={ex.id}
              data-testid={`excecao-${ex.id}`}
              className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
            >
              <span>
                {ex.exception_date}
                {ex.reason ? ` — ${ex.reason}` : ""}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={remover.isPending}
                onClick={() => remover.mutate(ex.id)}
              >
                {t("Remover")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
