"use client";

import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { useT } from "@/hooks/i18n/useT";
import { useUser } from "@/hooks/auth/AuthProvider";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useCreateContact } from "@/hooks/contacts/useCreateContact";
import { useCreateLead } from "@/hooks/kanban/useCreateLead";
import { useWhatsAppCountryCode } from "@/hooks/settings/useWhatsAppCountryCode";
import { apiClient } from "@/lib/api/client";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import type { Stage } from "@/lib/kanban/types";
import { createLeadSchema, type CreateLeadInput } from "@/lib/schemas/leads";
import { parseReaisToCents } from "@/lib/money";
import { gerarLinkWhatsApp, paraE164ComCodigoPadrao } from "@/lib/leads/whatsapp-link";
import { normalizarLink } from "@/lib/leads/social-links";
import { WhatsappLogo } from "@/lib/ui/icons";
import { EcoDoValor } from "./EcoDoValor";
import { SecaoRecolhivel } from "./SecaoRecolhivel";

interface FormShape {
  stage_id: string;
  nome: string;
  sobrenome: string;
  email: string;
  telefone: string;
  funcao: string;
  valueReais: string;
  ownerUserId: string;
  proximoContato: string;
  descricao: string;
  website_url: string;
  instagram_url: string;
  facebook_url: string;
  google_maps_url: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  pipelineId: string;
  stages: Stage[];
  /** Vincula o lead criado a este contato de origem (ex.: painel do Inbox). */
  contactId?: string | null;
  /** Nome do contato de origem — vira o título do negócio quando `contactId` já veio de fora. */
  contactName?: string | null;
  /** Depois do INSERT — o inbox relê o resumo para o lead novo aparecer no formulário. */
  onCreated?: () => void;
}

const VAZIO: FormShape = {
  stage_id: "",
  nome: "",
  sobrenome: "",
  email: "",
  telefone: "",
  funcao: "",
  valueReais: "",
  ownerUserId: "",
  proximoContato: "",
  descricao: "",
  website_url: "",
  instagram_url: "",
  facebook_url: "",
  google_maps_url: "",
};

function defaultStageId(stages: Stage[]): string {
  const open = stages.find((s) => !s.is_won && !s.is_lost && !s.is_archived);
  return open?.id ?? stages[0]?.id ?? "";
}

/**
 * "Novo negócio" — um formulário só, contato e negócio juntos. Antes disto,
 * criar um lead deixava o contato pra depois: quem quisesse tag, telefone,
 * rede social ou função do contato tinha que abrir o dossiê e procurar. Já
 * nasce vinculado, e as informações mais usadas entram de uma vez.
 */
export function NewLeadDialog({
  open,
  onOpenChange,
  pipelineId,
  stages,
  contactId,
  contactName,
  onCreated,
}: Props) {
  /** Contato já veio de fora (ex.: painel do Inbox) — não pede os campos dele de novo. */
  const contatoJaExiste = Boolean(contactId);
  const t = useT();
  const user = useUser();
  const { data: members } = useAssignableMembers(open);
  const countryCode = useWhatsAppCountryCode();
  const createContact = useCreateContact();
  const createLead = useCreateLead(pipelineId);
  const initialStage = useMemo(() => defaultStageId(stages), [stages]);
  const [enviando, setEnviando] = useState(false);

  const form = useForm<FormShape>({ defaultValues: { ...VAZIO, stage_id: initialStage } });

  useEffect(() => {
    if (!form.getValues("stage_id") && initialStage) {
      form.setValue("stage_id", initialStage);
    }
  }, [initialStage, form]);

  const telefone = form.watch("telefone");
  const linkWhatsApp = gerarLinkWhatsApp(telefone, countryCode.data ?? "55");

  async function onSubmit(values: FormShape) {
    const nomeCompleto = contatoJaExiste
      ? (contactName?.trim() || t("Negócio"))
      : `${values.nome.trim()} ${values.sobrenome.trim()}`.trim();
    if (!contatoJaExiste && !nomeCompleto) {
      form.setError("nome", { message: t("Informe ao menos o nome.") });
      return;
    }

    const reais = values.valueReais.trim();
    let valueCents: number | null = null;
    if (reais.length > 0) {
      valueCents = parseReaisToCents(reais);
      if (valueCents === null) {
        form.setError("valueReais", { message: t("Valor inválido") });
        return;
      }
    }

    setEnviando(true);
    try {
      // 1) O CONTATO primeiro — item 1 do pedido: tags, redes sociais e
      // telefone pertencem a ele, não ao negócio. Sem contato não há onde
      // gravar nenhum dos três. Pulado quando o contato já veio de fora
      // (ex.: painel do Inbox) — criar outro aqui duplicaria a pessoa.
      let resolvedContactId = contactId ?? null;
      if (!contatoJaExiste) {
        const telefoneDigitado = values.telefone.trim();
        const e164 = telefoneDigitado
          ? paraE164ComCodigoPadrao(telefoneDigitado, countryCode.data ?? "55")
          : null;
        const contactPayload: Record<string, unknown> = {
          name: nomeCompleto,
          source: "manual",
        };
        if (values.email.trim()) contactPayload.email = values.email.trim();
        if (telefoneDigitado) contactPayload.phone_raw = telefoneDigitado;
        if (e164 && /^\+\d{8,15}$/.test(e164)) contactPayload.phone_number = canonicalPhoneBR(e164);
        if (values.funcao.trim()) contactPayload.job_title = values.funcao.trim();
        if (values.website_url.trim()) contactPayload.website_url = values.website_url.trim();
        if (values.instagram_url.trim()) contactPayload.instagram_url = values.instagram_url.trim();
        if (values.facebook_url.trim()) contactPayload.facebook_url = values.facebook_url.trim();
        if (values.google_maps_url.trim()) contactPayload.google_maps_url = values.google_maps_url.trim();

        const criado = await createContact.mutateAsync(contactPayload as never);
        resolvedContactId = criado.data.id;
      }

      // 2) O NEGÓCIO, vinculado ao contato que acabou de nascer (ou ao que
      // já veio de fora, ex.: painel do Inbox).
      const leadPayload: Record<string, unknown> = {
        pipeline_id: pipelineId,
        stage_id: values.stage_id,
        title: nomeCompleto,
        currency: "BRL",
        source: "manual",
        contact_id: resolvedContactId,
      };
      if (values.descricao.trim()) leadPayload.description = values.descricao.trim();
      if (valueCents !== null) leadPayload.value_cents = valueCents;
      if (values.ownerUserId) leadPayload.owner_user_id = values.ownerUserId;

      const parsed = createLeadSchema.safeParse(leadPayload);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        toast.error(first?.message ?? t("Dados inválidos"));
        return;
      }
      const leadCriado = await createLead.mutateAsync(parsed.data as CreateLeadInput);

      // 3) "Próximo contato" — best-effort: falha aqui nunca desfaz o
      // negócio que acabou de ser criado.
      if (values.proximoContato) {
        try {
          await apiClient.post(`/api/v1/leads/${leadCriado.data.id}/compromissos`, {
            type: "proximo_contato",
            title: t("Próximo contato"),
            scheduled_at: new Date(`${values.proximoContato}T09:00:00`).toISOString(),
            assigned_to: values.ownerUserId || user.id,
          });
        } catch {
          toast.error(t("Negócio criado, mas não consegui agendar o próximo contato."));
        }
      }

      toast.success(t("Negócio criado"));
      onCreated?.();
      form.reset({ ...VAZIO, stage_id: initialStage });
      onOpenChange(false);
    } catch {
      // toast já mostrado pelos hooks (showApiError)
    } finally {
      setEnviando(false);
    }
  }

  const stageId = form.watch("stage_id");
  const pendente = enviando || createContact.isPending || createLead.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Novo negócio")}</DialogTitle>
          <DialogDescription>
            {t("Cria o contato e o negócio juntos, já vinculados.")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label>{t("Etapa")}</Label>
            <Select value={stageId} onValueChange={(v) => form.setValue("stage_id", v)}>
              <SelectTrigger>
                <SelectValue placeholder={t("Selecione a etapa")} />
              </SelectTrigger>
              <SelectContent>
                {stages
                  .filter((s) => !s.is_archived)
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          {contatoJaExiste ? (
            <p className="rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
              {t("Contato")}: <span className="font-medium text-text">{contactName ?? t("(sem nome)")}</span>
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="nome">{t("Nome")}</Label>
                  <Input id="nome" {...form.register("nome", { required: true })} />
                  {form.formState.errors.nome && (
                    <p className="text-xs text-error-fg">{form.formState.errors.nome.message}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sobrenome">{t("Sobrenome")}</Label>
                  <Input id="sobrenome" {...form.register("sobrenome")} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="email">{t("E-mail")}</Label>
                  <Input id="email" type="email" {...form.register("email")} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="telefone">{t("Telefone")}</Label>
                  <div className="flex gap-1">
                    <Input id="telefone" maxLength={30} {...form.register("telefone")} />
                    {linkWhatsApp && (
                      <a
                        href={linkWhatsApp}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-emerald-600 hover:bg-emerald-500/10"
                        aria-label={t("Abrir conversa no WhatsApp")}
                      >
                        <WhatsappLogo size={16} weight="fill" aria-hidden />
                      </a>
                    )}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="funcao">{t("Função")}</Label>
                <Input id="funcao" maxLength={150} placeholder={t("ex.: gerente de compras")} {...form.register("funcao")} />
              </div>
            </>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="valueReais">{t("Valor da negociação (R$)")}</Label>
              <Input id="valueReais" inputMode="decimal" placeholder="0,00" {...form.register("valueReais")} />
              <EcoDoValor control={form.control} />
              {form.formState.errors.valueReais && (
                <p className="text-xs text-error-fg">{form.formState.errors.valueReais.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t("Responsável")}</Label>
              <Select
                value={form.watch("ownerUserId") || "none"}
                onValueChange={(v) => form.setValue("ownerUserId", v === "none" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("Sem responsável")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("Sem responsável")}</SelectItem>
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

          <div className="space-y-2">
            <Label htmlFor="proximoContato">{t("Próximo contato")}</Label>
            <Input id="proximoContato" type="date" className="max-w-[10rem]" {...form.register("proximoContato")} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="descricao">{t("Observações")}</Label>
            <Textarea id="descricao" rows={2} placeholder={t("Contexto, observações, links…")} {...form.register("descricao")} />
          </div>

          {!contatoJaExiste && (
            <SecaoRecolhivel titulo={t("Redes sociais e links")} defaultOpen>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="website_url" className="text-xs">{t("Site")}</Label>
                  <div className="flex gap-1">
                    <Input id="website_url" maxLength={500} placeholder="https://…" {...form.register("website_url")} />
                    {normalizarLink(form.watch("website_url")) && (
                      <a
                        href={normalizarLink(form.watch("website_url"))!.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-text-muted hover:text-text"
                      >
                        ↗
                      </a>
                    )}
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="instagram_url" className="text-xs">Instagram</Label>
                  <Input id="instagram_url" maxLength={500} placeholder="https://…" {...form.register("instagram_url")} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="facebook_url" className="text-xs">Facebook</Label>
                  <Input id="facebook_url" maxLength={500} placeholder="https://…" {...form.register("facebook_url")} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="google_maps_url" className="text-xs">Google Maps</Label>
                  <Input id="google_maps_url" maxLength={1000} placeholder="https://…" {...form.register("google_maps_url")} />
                </div>
              </div>
            </SecaoRecolhivel>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pendente}>
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={pendente || !stageId}>
              {pendente ? t("Criando…") : t("Criar negócio")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
