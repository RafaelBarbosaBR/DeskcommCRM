"use client";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { perfilDoPais } from "@/lib/legal/perfil-do-pais";
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
import { normalizarTags } from "@/lib/contacts/tag-normalizada";
import { contactCreateSchemaDoPais, type ContactCreate } from "@/lib/schemas/contacts";
import type { Contact } from "@/lib/types/contacts";
import { useCreateContact } from "@/hooks/contacts/useCreateContact";
import {
  aplicarLinks,
  EXEMPLO_DE_LINK,
  normalizarLink,
  TIPOS_DE_LINK,
  tiposInvalidos,
  type LinksDoContato,
  type TipoDeLink,
} from "@/lib/leads/links-de-contato";

interface FormShape {
  name?: string;
  email?: string;
  phone_number?: string;
  cpf?: string;
  tagsRaw?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /**
   * Nome já digitado por quem chamou, para não redigitar. Quem abre com um termo
   * de busca em mãos passa aqui; o resto continua abrindo vazio.
   *
   * É `defaultValue` do formulário, então só vale na montagem — quem precisa
   * trocar o termo com o diálogo já montado remonta com `key`.
   */
  nomeInicial?: string;
  /**
   * Recebe o contato recém-criado. Existe para quem abriu o diálogo NO MEIO de
   * outro fluxo (marcar um horário, por exemplo) poder seguir com ele já
   * selecionado, em vez de mandar a pessoa procurar de novo o que acabou de criar.
   */
  onCriado?: (contato: Contact) => void;
}

export function NewContactDialog({ open, onOpenChange, nomeInicial, onCriado }: Props) {
  const t = useT();
  const perfil = perfilDoPais(useActiveOrg()?.country);
  const create = useCreateContact();
  const [serverError, setServerError] = useState<string | null>(null);
  // Os links começam escondidos: a maioria dos contatos nasce sem eles, e oito
  // campos a mais no diálogo mais usado do produto puniria todo mundo pelo caso
  // de quem precisa. Quem abre vê o resto do formulário continua na mesma tela.
  const [mostrarLinks, setMostrarLinks] = useState(false);
  const [linksValores, setLinksValores] = useState<LinksDoContato>({});
  const [linksTentouSalvar, setLinksTentouSalvar] = useState(false);
  const linksInvalidos = new Set<TipoDeLink>(tiposInvalidos(linksValores));

  function definirLink(tipo: TipoDeLink, valor: string) {
    setLinksValores((atual) => ({ ...atual, [tipo]: valor }));
  }

  const form = useForm<FormShape>({
    defaultValues: { name: nomeInicial ?? "", email: "", phone_number: "", cpf: "", tagsRaw: "" },
  });

  // `t()` com literal, não `t(rotulo)`: a guarda de i18n trata chamada com
  // parâmetro dinâmico como dívida nova, e `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`
  // só deixa a lista de exceções encolher, nunca crescer. `Record<TipoDeLink, …>`
  // quebra a compilação se um tipo novo entrar em TIPOS_DE_LINK sem rótulo aqui.
  const rotulosDosLinks: Record<TipoDeLink, string> = {
    instagram: t("Instagram"),
    site: t("Site"),
    google_meu_negocio: t("Google Meu Negócio"),
    facebook: t("Facebook"),
    linkedin: t("LinkedIn"),
    tiktok: t("TikTok"),
    youtube: t("YouTube"),
    outro: t("Outro"),
  };

  async function onSubmit(values: FormShape) {
    setServerError(null);
    if (linksInvalidos.size > 0) {
      setLinksTentouSalvar(true);
      toast.error(t("Confira os links marcados: só endereços http(s) valem."));
      return;
    }
    // A MESMA normalização da API (lib/contacts/tag-normalizada): o que a ficha
    // grava é o que o filtro `?tag=` casa (issue #1224).
    const tags = normalizarTags((values.tagsRaw ?? "").split(","));
    // `aplicarLinks(null, …)` devolve só as chaves `link_<tipo>` preenchidas —
    // ninguém cadastrou `custom_fields` antes deste contato existir.
    const links = aplicarLinks(null, linksValores);

    const payload: Record<string, unknown> = { source: "manual" };
    if (values.name?.trim()) payload.name = values.name.trim();
    if (values.email?.trim()) payload.email = values.email.trim();
    if (values.phone_number?.trim()) payload.phone_number = values.phone_number.trim();
    if (values.cpf?.trim()) payload.cpf = values.cpf.trim();
    if (tags.length) payload.tags = tags;
    if (Object.keys(links).length > 0) payload.custom_fields = links;

    // A MESMA régua do servidor: a tela que mostra 'Bilhete' não pode
    // recusá-lo como CPF antes de chegar lá.
    const parsed = contactCreateSchemaDoPais(perfil).safeParse(payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      setServerError(first?.message ?? t("Dados inválidos"));
      return;
    }

    try {
      const resposta = await create.mutateAsync(parsed.data as ContactCreate);
      toast.success(t("Contato criado"));
      form.reset();
      setMostrarLinks(false);
      setLinksValores({});
      setLinksTentouSalvar(false);
      onOpenChange(false);
      // `.data` é o envelope do `ok()`, e dentro dele mora `{ contact, action }`.
      // Entregar `resposta.data` aqui devolveria esse envelope como se fosse o
      // contato: o `id` sairia `undefined` e a marcação ficaria sem ninguém, em
      // silêncio. Quem garante que este caminho não volta a errar é o tipo do
      // hook, ligado ao retorno da rota.
      if (resposta?.data?.contact) onCriado?.(resposta.data.contact);
    } catch {
      // error toast already handled by hook
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Novo contato")}</DialogTitle>
          <DialogDescription>
            {t("Preencha pelo menos um identificador (email ou telefone).")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">{t("Nome")}</Label>
            <Input id="name" {...form.register("name")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">{t("Email")}</Label>
            <Input id="email" type="email" {...form.register("email")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone_number">{t("Telefone (E.164)")}</Label>
            <Input
              id="phone_number"
              placeholder={perfil.telefoneExemplo}
              {...form.register("phone_number")}
            />
          </div>
          <div className="space-y-2">
            {/* O documento é o do PAÍS da organização — a API já valida por ele
                (`contactCreateSchemaDoPais`); só a tela escrevia "CPF" em duro. */}
            <Label htmlFor="cpf">
              {perfil.documento.rotulo} ({t("opcional")})
            </Label>
            <Input id="cpf" placeholder={perfil.documento.exemplo} {...form.register("cpf")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tagsRaw">{t("Tags (separadas por vírgula)")}</Label>
            <Input id="tagsRaw" placeholder="vip, recompra" {...form.register("tagsRaw")} />
          </div>
          <div className="space-y-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="px-0 text-text-muted hover:text-text"
              onClick={() => setMostrarLinks((v) => !v)}
            >
              {mostrarLinks ? t("Ocultar links e redes sociais") : t("+ Links e redes sociais")}
            </Button>
            {mostrarLinks && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {TIPOS_DE_LINK.map(({ id }) => {
                  const rotulo = rotulosDosLinks[id];
                  const href = normalizarLink(linksValores[id]);
                  const erro = linksTentouSalvar && linksInvalidos.has(id);
                  return (
                    <div key={id} className="space-y-1">
                      <Label htmlFor={`novo-contato-link-${id}`} className="text-xs">
                        {rotulo}
                      </Label>
                      <div className="flex gap-1">
                        <Input
                          id={`novo-contato-link-${id}`}
                          value={linksValores[id] ?? ""}
                          onChange={(e) => definirLink(id, e.target.value)}
                          maxLength={1000}
                          placeholder={EXEMPLO_DE_LINK}
                          aria-invalid={erro || undefined}
                          className={erro ? "border-destructive" : undefined}
                        />
                        {href && (
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`${t("Abrir")} ${rotulo}`}
                            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-text-muted hover:text-text"
                          >
                            ↗
                          </a>
                        )}
                      </div>
                      {erro && <p className="text-[11px] text-destructive">{t("Endereço inválido.")}</p>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {serverError && (
            <p className="text-sm text-error-fg">{serverError}</p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={create.isPending}
            >
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? t("Criando…") : t("Criar contato")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
