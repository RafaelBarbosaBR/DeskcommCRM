"use client";

import { useEffect, useState } from "react";

import { toast } from "sonner";

import { useT } from "@/hooks/i18n/useT";
import { useContact } from "@/hooks/contacts/useContact";
import { useCreateContact } from "@/hooks/contacts/useCreateContact";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import { useEditLead } from "@/hooks/kanban/useUpdateLead";
import { useWhatsAppCountryCode } from "@/hooks/settings/useWhatsAppCountryCode";
import { ContactTagsEditor } from "@/components/inbox/ContactTagsEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowSquareOut, WhatsappLogo } from "@/lib/ui/icons";
import { normalizarLink } from "@/lib/leads/social-links";
import { gerarLinkWhatsApp, paraE164ComCodigoPadrao } from "@/lib/leads/whatsapp-link";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";

interface Props {
  contactId: string | null;
  leadId: string;
  leadTitle: string;
  pipelineId: string;
}

interface RascunhoDeContato {
  nome: string;
  sobrenome: string;
  email: string;
  telefone: string;
  funcao: string;
  website_url: string;
  instagram_url: string;
  facebook_url: string;
  google_maps_url: string;
}

/**
 * Negócio criado sem contato vinculado (comum: "+ Novo negócio" não exige
 * contato) não tem ONDE guardar nome, e-mail, função, tag, rede social ou
 * telefone — todos os seis são campos do CONTATO (item 1 do pedido), não do
 * lead. Em vez de pedir só um nome, oferece o MESMO conjunto de campos do
 * formulário de "Novo negócio" — quem chegou aqui não devia precisar abrir
 * outro formulário pra terminar de cadastrar a pessoa.
 */
function SemContatoVinculado({ leadId, leadTitle, pipelineId }: Omit<Props, "contactId">) {
  const t = useT();
  const countryCode = useWhatsAppCountryCode();
  const criarContato = useCreateContact();
  const editarLead = useEditLead(pipelineId);
  const [campo, setCampo] = useState<RascunhoDeContato>({
    nome: leadTitle,
    sobrenome: "",
    email: "",
    telefone: "",
    funcao: "",
    website_url: "",
    instagram_url: "",
    facebook_url: "",
    google_maps_url: "",
  });

  function set<K extends keyof RascunhoDeContato>(chave: K, valor: string) {
    setCampo((c) => ({ ...c, [chave]: valor }));
  }

  const linkWhatsApp = gerarLinkWhatsApp(campo.telefone, countryCode.data ?? "55");

  function vincular() {
    const nomeCompleto = `${campo.nome.trim()} ${campo.sobrenome.trim()}`.trim();
    if (!nomeCompleto) {
      toast.error(t("Informe ao menos o nome."));
      return;
    }

    const payload: Record<string, unknown> = { name: nomeCompleto, source: "manual" };
    if (campo.email.trim()) payload.email = campo.email.trim();
    if (campo.telefone.trim()) {
      payload.phone_raw = campo.telefone.trim();
      const e164 = paraE164ComCodigoPadrao(campo.telefone.trim(), countryCode.data ?? "55");
      if (e164 && /^\+\d{8,15}$/.test(e164)) payload.phone_number = canonicalPhoneBR(e164);
    }
    if (campo.funcao.trim()) payload.job_title = campo.funcao.trim();
    if (campo.website_url.trim()) payload.website_url = campo.website_url.trim();
    if (campo.instagram_url.trim()) payload.instagram_url = campo.instagram_url.trim();
    if (campo.facebook_url.trim()) payload.facebook_url = campo.facebook_url.trim();
    if (campo.google_maps_url.trim()) payload.google_maps_url = campo.google_maps_url.trim();

    criarContato.mutate(payload as never, {
      onSuccess: (resultado) => {
        editarLead.mutate({ leadId, patch: { contact_id: resultado.data.id } });
      },
    });
  }

  const pendente = criarContato.isPending || editarLead.isPending;

  return (
    <div className="space-y-3">
      <p className="text-xs text-text-muted">
        {t("Este negócio não tem um contato vinculado — nome, tags, redes sociais e telefone pertencem ao contato, não ao negócio. Preencha e vincule aqui.")}
      </p>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">{t("Nome")}</Label>
          <Input value={campo.nome} onChange={(e) => set("nome", e.target.value)} maxLength={150} className="h-8 text-xs" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("Sobrenome")}</Label>
          <Input value={campo.sobrenome} onChange={(e) => set("sobrenome", e.target.value)} maxLength={150} className="h-8 text-xs" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("E-mail")}</Label>
          <Input type="email" value={campo.email} onChange={(e) => set("email", e.target.value)} maxLength={320} className="h-8 text-xs" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("Telefone")}</Label>
          <div className="flex gap-1">
            <Input value={campo.telefone} onChange={(e) => set("telefone", e.target.value)} maxLength={30} placeholder="(11) 98888-7777" className="h-8 text-xs" />
            {linkWhatsApp && (
              <a
                href={linkWhatsApp}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-emerald-600 hover:bg-emerald-500/10"
                aria-label={t("Abrir conversa no WhatsApp")}
              >
                <WhatsappLogo size={16} weight="fill" aria-hidden />
              </a>
            )}
          </div>
        </div>
        <div className="col-span-2 space-y-1">
          <Label className="text-xs">{t("Função")}</Label>
          <Input value={campo.funcao} onChange={(e) => set("funcao", e.target.value)} maxLength={150} placeholder={t("ex.: gerente de compras")} className="h-8 text-xs" />
        </div>
      </div>

      <div>
        <p className="mb-1 text-[11px] font-medium uppercase text-text-muted">{t("Redes sociais")}</p>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs">{t("Site")}</Label>
            <Input value={campo.website_url} onChange={(e) => set("website_url", e.target.value)} maxLength={500} placeholder="https://…" className="h-8 text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Instagram</Label>
            <Input value={campo.instagram_url} onChange={(e) => set("instagram_url", e.target.value)} maxLength={500} placeholder="https://…" className="h-8 text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Facebook</Label>
            <Input value={campo.facebook_url} onChange={(e) => set("facebook_url", e.target.value)} maxLength={500} placeholder="https://…" className="h-8 text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Google Maps</Label>
            <Input value={campo.google_maps_url} onChange={(e) => set("google_maps_url", e.target.value)} maxLength={1000} placeholder="https://…" className="h-8 text-xs" />
          </div>
        </div>
      </div>

      <Button size="sm" onClick={vincular} disabled={pendente} className="w-full">
        {pendente ? t("Criando…") : t("Criar e vincular contato")}
      </Button>
    </div>
  );
}

/** Botão "abrir em nova aba" — só aparece quando o campo tem valor (item 2). */
function BotaoDeAbrir({ valor }: { valor: string }) {
  const link = normalizarLink(valor);
  if (!link) return null;
  return (
    <a
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-text-muted hover:text-text"
      aria-label="Abrir em nova aba"
    >
      <ArrowSquareOut size={14} weight="regular" aria-hidden />
    </a>
  );
}

function CampoDeLink({
  id,
  label,
  valor,
  maxLength,
  onCommit,
}: {
  id: string;
  label: string;
  valor: string;
  maxLength: number;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(valor);
  useEffect(() => setDraft(valor), [valor]);

  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <div className="flex gap-1">
        <Input
          id={id}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== valor) onCommit(draft);
          }}
          maxLength={maxLength}
          className="h-8 text-xs"
        />
        <BotaoDeAbrir valor={draft} />
      </div>
    </div>
  );
}

/**
 * TUDO do contato dentro do dossiê do lead: nome/sobrenome, e-mail, função,
 * tags (item 1), redes sociais (item 2) e telefone/WhatsApp (item 3) — sem
 * precisar sair da ficha do negócio pra editar o contato em outro lugar. Um
 * `useContact` só, cinco seções.
 */
function separarNome(nomeCompleto: string): { nome: string; sobrenome: string } {
  const partes = nomeCompleto.trim().split(/\s+/).filter(Boolean);
  return { nome: partes[0] ?? "", sobrenome: partes.slice(1).join(" ") };
}

export function ContatoExtras({ contactId, leadId, leadTitle, pipelineId }: Props) {
  const t = useT();
  const contactQuery = useContact(contactId ?? "");
  const mutation = useUpdateContact(contactId ?? "");
  const countryCode = useWhatsAppCountryCode();
  const [phoneDraft, setPhoneDraft] = useState("");
  const [nomeDraft, setNomeDraft] = useState("");
  const [sobrenomeDraft, setSobrenomeDraft] = useState("");
  const [emailDraft, setEmailDraft] = useState("");
  const [funcaoDraft, setFuncaoDraft] = useState("");

  const contact = contactQuery.data?.data;

  useEffect(() => {
    setPhoneDraft(contact?.phone_raw ?? "");
    const { nome, sobrenome } = separarNome(contact?.name ?? "");
    setNomeDraft(nome);
    setSobrenomeDraft(sobrenome);
    setEmailDraft(contact?.email ?? "");
    setFuncaoDraft(contact?.job_title ?? "");
  }, [contact?.phone_raw, contact?.name, contact?.email, contact?.job_title]);

  function salvarNome() {
    const nomeCompleto = `${nomeDraft.trim()} ${sobrenomeDraft.trim()}`.trim();
    const atual = contact?.name ?? "";
    if (nomeCompleto && nomeCompleto !== atual) mutation.mutate({ name: nomeCompleto });
  }

  if (!contactId) {
    return <SemContatoVinculado leadId={leadId} leadTitle={leadTitle} pipelineId={pipelineId} />;
  }
  if (contactQuery.isLoading) {
    return <p className="text-xs text-text-muted">{t("Carregando…")}</p>;
  }
  if (!contact) {
    return (
      <p className="text-xs text-warning-fg">
        {t("Não consegui carregar os dados do contato.")}
      </p>
    );
  }

  const linkWhatsApp = gerarLinkWhatsApp(phoneDraft, countryCode.data ?? "55");

  function salvarLink(campo: "website_url" | "instagram_url" | "facebook_url" | "google_maps_url") {
    return (valor: string) => mutation.mutate({ [campo]: valor } as Record<string, string>);
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
          {t("Dados de contato")}
        </h3>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="contato-nome" className="text-xs">{t("Nome")}</Label>
            <Input
              id="contato-nome"
              value={nomeDraft}
              onChange={(e) => setNomeDraft(e.target.value)}
              onBlur={salvarNome}
              maxLength={150}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="contato-sobrenome" className="text-xs">{t("Sobrenome")}</Label>
            <Input
              id="contato-sobrenome"
              value={sobrenomeDraft}
              onChange={(e) => setSobrenomeDraft(e.target.value)}
              onBlur={salvarNome}
              maxLength={150}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="contato-email" className="text-xs">{t("E-mail")}</Label>
            <Input
              id="contato-email"
              type="email"
              value={emailDraft}
              onChange={(e) => setEmailDraft(e.target.value)}
              onBlur={() => {
                if (emailDraft.trim() && emailDraft.trim() !== (contact.email ?? "")) {
                  mutation.mutate({ email: emailDraft.trim() });
                }
              }}
              maxLength={320}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="contato-funcao" className="text-xs">{t("Função")}</Label>
            <Input
              id="contato-funcao"
              value={funcaoDraft}
              onChange={(e) => setFuncaoDraft(e.target.value)}
              onBlur={() => {
                if (funcaoDraft !== (contact.job_title ?? "")) mutation.mutate({ job_title: funcaoDraft });
              }}
              maxLength={150}
              placeholder={t("ex.: gerente de compras")}
              className="h-8 text-xs"
            />
          </div>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
          {t("Tags")}
        </h3>
        <ContactTagsEditor contactId={contactId} tags={contact.tags ?? []} />
      </div>

      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
          {t("Telefone")}
        </h3>
        <div className="flex gap-1">
          <Input
            value={phoneDraft}
            onChange={(e) => setPhoneDraft(e.target.value)}
            onBlur={() => {
              if (phoneDraft === (contact.phone_raw ?? "")) return;
              const patch: Record<string, string> = { phone_raw: phoneDraft };
              // `phone_number` (a coluna canônica que já existia) só é tocada
              // quando dá pra calcular um E.164 válido — item 3 do pedido:
              // as duas colunas nunca se sobrescrevem por acidente.
              const e164 = phoneDraft
                ? paraE164ComCodigoPadrao(phoneDraft, countryCode.data ?? "55")
                : null;
              if (e164 && /^\+\d{8,15}$/.test(e164)) {
                patch.phone_number = canonicalPhoneBR(e164);
              }
              mutation.mutate(patch);
            }}
            maxLength={30}
            placeholder="(11) 98888-7777"
            className="h-8 text-xs"
          />
          {linkWhatsApp && (
            <a
              href={linkWhatsApp}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-emerald-600 hover:bg-emerald-500/10"
              aria-label={t("Abrir conversa no WhatsApp")}
            >
              <WhatsappLogo size={16} weight="fill" aria-hidden />
            </a>
          )}
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
          {t("Redes sociais")}
        </h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <CampoDeLink
            id="website_url"
            label={t("Site")}
            valor={contact.website_url ?? ""}
            maxLength={500}
            onCommit={salvarLink("website_url")}
          />
          <CampoDeLink
            id="instagram_url"
            label="Instagram"
            valor={contact.instagram_url ?? ""}
            maxLength={500}
            onCommit={salvarLink("instagram_url")}
          />
          <CampoDeLink
            id="facebook_url"
            label="Facebook"
            valor={contact.facebook_url ?? ""}
            maxLength={500}
            onCommit={salvarLink("facebook_url")}
          />
          <CampoDeLink
            id="google_maps_url"
            label="Google Maps"
            valor={contact.google_maps_url ?? ""}
            maxLength={1000}
            onCommit={salvarLink("google_maps_url")}
          />
        </div>
      </div>
    </div>
  );
}
