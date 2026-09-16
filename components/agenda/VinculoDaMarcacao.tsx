"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { showApiError } from "@/components/feedback/ApiErrorToast";

type Vinculos = {
  contacts: Array<{ id: string; name: string }>;
  conversations: Array<{ id: string; created_at: string; status: string }>;
};

/**
 * "Criar novo contato" INLINE — a busca só achava contato JÁ cadastrado
 * (`ilike name` em `/api/v1/agenda/vinculos`). Sem match, o único caminho era
 * sair da marcação, ir em Contatos, criar, e voltar torcendo pra lembrar o
 * que estava preenchendo. O formulário some assim que cria (ou vincula ao
 * existente, no caso do 409) — não é uma segunda tela, é a mesma marcação.
 */
function CriarContatoInline({
  nomeInicial,
  onCriado,
}: {
  nomeInicial: string;
  onCriado: (contactId: string) => void;
}) {
  const t = useT();
  const [nome, setNome] = useState(nomeInicial);
  const [telefone, setTelefone] = useState("");
  const [criando, setCriando] = useState(false);

  // Sem invalidar cache nenhum de propósito: `onCriado` troca `contactId` no
  // PAI, que muda a `queryKey` de `VinculoDaMarcacao` (de busca-por-nome pra
  // busca-por-id) — o próprio react-query já refaz a chamada sozinho.
  async function criar() {
    setCriando(true);
    try {
      const { data } = await apiClient.post<{ data: { id: string } }>("/api/v1/contacts", {
        name: nome.trim() || undefined,
        phone_number: telefone.trim() || undefined,
      });
      onCriado(data.id);
    } catch (err) {
      // 409 contact_exists: o telefone já existe em outro contato (issue do
      // changelog upstream, item 1.3 desta mesma leva) — em vez de um erro
      // morto, vincula ao contato que JÁ tem aquele telefone. Duplicar não
      // era a intenção de quem digitou o telefone de novo, era achar a pessoa.
      if (err instanceof ApiError && err.code === "contact_exists" && err.details?.contact_id) {
        onCriado(String(err.details.contact_id));
        return;
      }
      showApiError(err);
    } finally {
      setCriando(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-dashed p-2" data-testid="criar-contato-inline">
      <p className="text-xs text-text-muted">{t("Nenhum cliente encontrado com esse nome.")}</p>
      <label className="block text-xs">
        {t("Nome")}
        <input
          className="mt-1 w-full rounded-md border bg-surface p-2"
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          aria-label={t("Nome do novo contato")}
        />
      </label>
      <label className="block text-xs">
        {t("Telefone (opcional)")}
        <input
          className="mt-1 w-full rounded-md border bg-surface p-2"
          placeholder="+5511999998888"
          value={telefone}
          onChange={(e) => setTelefone(e.target.value)}
          aria-label={t("Telefone do novo contato")}
        />
      </label>
      <Button
        type="button"
        size="sm"
        disabled={!nome.trim() || criando}
        onClick={() => void criar()}
      >
        {criando ? t("Criando…") : t("Criar contato")}
      </Button>
    </div>
  );
}

export function VinculoDaMarcacao({
  contactId,
  conversationId,
  onChange,
}: {
  contactId: string;
  conversationId: string;
  onChange: (contact: string, conversation: string) => void;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const query = useQuery({
    queryKey: ["agenda", "vinculos", contactId, search],
    queryFn: async () =>
      (
        await apiClient.get<{ data: Vinculos }>(
          `/api/v1/agenda/vinculos?${new URLSearchParams(contactId ? { contact_id: contactId } : { q: search })}`,
        )
      ).data,
  });
  // "Criar novo contato" só aparece depois de uma busca de verdade (não com a
  // caixa vazia, que listaria "ninguém encontrado" para todo mundo que abre o
  // painel) e só quando a busca JÁ voltou (nunca durante o carregamento).
  const semResultado =
    !contactId && search.trim().length >= 2 && !query.isFetching && query.data?.contacts.length === 0;
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <label className="block">
        {t("Buscar cliente")}
        <input
          className="mt-1 w-full rounded-md border bg-surface p-2"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            onChange("", "");
          }}
        />
      </label>
      <label className="block">
        {t("Quem será atendido")}
        <select
          className="mt-1 w-full rounded-md border bg-surface p-2"
          value={contactId}
          onChange={(e) => onChange(e.target.value, "")}
        >
          <option value="">{t("Compromisso pessoal, sem cliente")}</option>
          {query.data?.contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {semResultado ? (
        <CriarContatoInline nomeInicial={search} onCriado={(id) => onChange(id, "")} />
      ) : null}
      {contactId ? (
        <label className="block">
          {t("Conversa vinculada (opcional)")}
          <select
            className="mt-1 w-full rounded-md border bg-surface p-2"
            value={conversationId}
            onChange={(e) => onChange(contactId, e.target.value)}
          >
            <option value="">{t("Sem conversa vinculada")}</option>
            {query.data?.conversations.map((c, i) => (
              <option key={c.id} value={c.id}>
                {t("Conversa")} {i + 1} · {new Date(c.created_at).toLocaleDateString()}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {query.isError ? (
        <p role="alert">{t("Não foi possível carregar os vínculos. Tente novamente.")}</p>
      ) : null}
    </div>
  );
}
