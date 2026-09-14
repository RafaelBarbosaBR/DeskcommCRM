"use client";

import { useState } from "react";
import { toast } from "sonner";

import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useUser } from "@/hooks/auth/AuthProvider";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import {
  useCompromissos,
  useCreateCompromisso,
  useDeleteCompromisso,
  useUpdateCompromisso,
  type Compromisso,
} from "@/hooks/leads/useCompromissos";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ROTULO_DO_STATUS,
  ROTULO_DO_TIPO,
  TIPOS_DE_COMPROMISSO,
  type TipoDeCompromisso,
} from "@/lib/leads/compromissos/tipos";

const LIMITE_TITULO = 200;
const LIMITE_NOTAS = 1000;

function paraDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function CardDeCompromisso({ leadId, compromisso }: { leadId: string; compromisso: Compromisso }) {
  const t = useT();
  const idioma = useTagDeIdioma();
  const update = useUpdateCompromisso(leadId);
  const del = useDeleteCompromisso(leadId);
  const [reagendando, setReagendando] = useState(false);
  const [novaData, setNovaData] = useState(paraDatetimeLocal(compromisso.scheduled_at));

  function confirmarReagendamento() {
    const iso = new Date(novaData).toISOString();
    update.mutate(
      { id: compromisso.id, scheduled_at: iso },
      { onSuccess: () => setReagendando(false) },
    );
  }

  return (
    <div className="rounded-md border border-border p-2 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-text">{compromisso.title}</p>
          <p className="text-text-muted">
            {t(ROTULO_DO_TIPO[compromisso.type])} · {t(ROTULO_DO_STATUS[compromisso.status])}
          </p>
          {compromisso.notes && <p className="mt-1 text-text-muted">{compromisso.notes}</p>}
        </div>
        <span className="shrink-0 text-text-muted">
          {new Date(compromisso.scheduled_at).toLocaleString(idioma)}
        </span>
      </div>

      {compromisso.google_sync_error && (
        <p className="mt-1 text-[11px] text-warning-fg">
          {t("Não sincronizado")}: {compromisso.google_sync_error}
        </p>
      )}

      {reagendando ? (
        <div className="mt-2 flex items-center gap-1">
          <Input
            type="datetime-local"
            value={novaData}
            onChange={(e) => setNovaData(e.target.value)}
            className="h-7 text-xs"
          />
          <Button size="sm" className="h-7" onClick={confirmarReagendamento} disabled={update.isPending}>
            {t("Confirmar")}
          </Button>
          <Button size="sm" variant="ghost" className="h-7" onClick={() => setReagendando(false)}>
            {t("Cancelar")}
          </Button>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1">
          {compromisso.status === "pending" && (
            <>
              <Button size="sm" variant="outline" className="h-7" onClick={() => setReagendando(true)}>
                {t("Reagendar")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                onClick={() => update.mutate({ id: compromisso.id, status: "completed" })}
                disabled={update.isPending}
              >
                {t("Concluir")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-destructive"
                onClick={() => update.mutate({ id: compromisso.id, status: "cancelled" })}
                disabled={update.isPending}
              >
                {t("Cancelar")}
              </Button>
            </>
          )}
          {compromisso.status !== "pending" && (
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() => update.mutate({ id: compromisso.id, status: "pending" })}
              disabled={update.isPending}
            >
              {t("Reabrir")}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-destructive"
            onClick={() => {
              if (window.confirm(t("Remover este compromisso?"))) del.mutate(compromisso.id);
            }}
            disabled={del.isPending}
          >
            {t("Remover")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Item 7 do pedido: formulário de criação embutido na própria aba do lead. */
function FormularioDeCompromisso({ leadId }: { leadId: string }) {
  const t = useT();
  const user = useUser();
  const { data: members } = useAssignableMembers(true);
  const create = useCreateCompromisso(leadId);

  const [type, setType] = useState<TipoDeCompromisso>("proximo_contato");
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [assignedTo, setAssignedTo] = useState(user.id);

  function criar() {
    if (!title.trim() || !scheduledAt) {
      toast.error(t("Preencha título e data."));
      return;
    }
    create.mutate(
      {
        type,
        title: title.trim(),
        notes: notes.trim() || null,
        scheduled_at: new Date(scheduledAt).toISOString(),
        assigned_to: assignedTo,
      },
      {
        onSuccess: () => {
          setTitle("");
          setNotes("");
          setScheduledAt("");
        },
      },
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-dashed border-border p-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[11px]">{t("Tipo")}</Label>
          <Select value={type} onValueChange={(v) => setType(v as TipoDeCompromisso)}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIPOS_DE_COMPROMISSO.map((tipo) => (
                <SelectItem key={tipo} value={tipo}>
                  {t(ROTULO_DO_TIPO[tipo])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">{t("Responsável")}</Label>
          <Select value={assignedTo} onValueChange={setAssignedTo}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={user.id}>{t("Eu")}</SelectItem>
              {(members ?? [])
                .filter((m) => m.user_id !== user.id)
                .map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {m.full_name ?? t("Sem nome")}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={LIMITE_TITULO}
        placeholder={t("Título do compromisso")}
        className="h-8 text-xs"
      />
      <Textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        maxLength={LIMITE_NOTAS}
        rows={2}
        placeholder={t("Observação (opcional)")}
        className="text-xs"
      />
      <div className="flex items-center gap-2">
        <Input
          type="datetime-local"
          value={scheduledAt}
          onChange={(e) => setScheduledAt(e.target.value)}
          className="h-8 flex-1 text-xs"
        />
        <Button size="sm" onClick={criar} disabled={create.isPending}>
          {create.isPending ? t("Criando…") : t("Criar compromisso")}
        </Button>
      </div>
    </div>
  );
}

export function AgendamentosDoLead({ leadId }: { leadId: string }) {
  const t = useT();
  const query = useCompromissos(leadId);

  return (
    <div>
      <FormularioDeCompromisso leadId={leadId} />
      <div className="mt-2 space-y-2">
        {query.isLoading && <p className="text-xs text-text-muted">{t("Carregando…")}</p>}
        {query.data?.length === 0 && (
          <p className="text-xs text-text-muted">{t("Nenhum compromisso marcado.")}</p>
        )}
        {query.data?.map((c) => (
          <CardDeCompromisso key={c.id} leadId={leadId} compromisso={c} />
        ))}
      </div>
    </div>
  );
}
