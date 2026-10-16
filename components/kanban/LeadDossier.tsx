"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useRef } from "react";

import { useT } from "@/hooks/i18n/useT";
import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { ROLE_RANK } from "@/lib/auth/types";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLeadTimeline } from "@/hooks/leads/useLeadTimeline";
import type { Lead } from "@/lib/types/leads";
import { ContatoDoNegocio } from "./ContatoDoNegocio";
import { ConversaNoDossie } from "./ConversaNoDossie";
import { LeadFieldsForm } from "./LeadFieldsForm";
import { ScoreSlot } from "./ScoreSlot";
import { LeadNoteComposer } from "./LeadNoteComposer";
import { LeadTimeline } from "./LeadTimeline";
import { PropostasDoNegocio } from "./PropostasDoNegocio";
import { OwnerBadge } from "./OwnerBadge";
import { resolveLeadOwner } from "@/lib/kanban/owner";
import { formatValorDoNegocio, MOEDA_PADRAO } from "@/lib/money";
import type { CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  lead: Lead;
  pipelineId: string;
  fieldDefs?: CustomFieldDef[];
  stageName: string;
  ownerNames?: Map<string, string | null>;
}

function formatValor(cents: number | null, currency: string | null): string {
  // Mesma régua e mesmo locale do card e do total da coluna (`formatValorDoNegocio`).
  if (cents === null) return "—";
  return formatValorDoNegocio(cents, currency ?? MOEDA_PADRAO, { semCentavos: true });
}

/**
 * O dossiê do negócio: duas colunas, lado a lado (decisão de 16/10, pedido
 * explícito de layout "com o histórico ao lado do card" — a mudança é só de
 * ESTRUTURA, nas cores e componentes que o produto já usa, sem clonar a
 * paleta escura de referência).
 *
 * Esquerda (estreita, rola sozinha): cabeçalho vivo, a aba "Principal" com
 * Contato, os campos do negócio e Propostas. Direita (larga, rola sozinha):
 * o atalho para a conversa e a linha do tempo.
 *
 * SÓ "Principal" existe como aba por agora — não há tela de Estatísticas,
 * Mídia nem catálogo de Produtos por negócio ainda; uma aba vazia mentiria
 * sobre o que o produto faz. A aba fica pronta para quando (se) essas telas
 * existirem.
 *
 * A ORDEM DENTRO DA COLUNA DIREITA preserva a decisão anterior: quem abre um
 * lead quer primeiro saber O QUE ACONTECEU — a conversa e a timeline, que
 * antes vinham antes dos campos, agora moram na própria coluna que não
 * disputa espaço com o formulário.
 *
 * SALVAR NÃO FECHA. Quem edita precisa ver a atividade que acabou de gerar
 * entrar na timeline; fechar esconderia o registro justamente de quem o
 * produziu, e a funcionalidade que prova "sua ação fica registrada" provaria
 * isso para todo mundo menos para o autor.
 */
export function LeadDossier({
  open,
  onOpenChange,
  lead,
  pipelineId,
  fieldDefs = [],
  stageName,
  ownerNames,
}: Props) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const campos = useRef<HTMLDivElement | null>(null);
  const timeline = useLeadTimeline(open ? lead.id : null, lead.contact_id);
  const owner = resolveLeadOwner(lead, ownerNames);
  const score = lead.score ?? null;
  // N1 — o atalho "Nova proposta" é manager+ (mesmo gate do envio, mesma
  // régua do BulkActionBar). O dossiê não tinha nenhuma checagem de papel;
  // esta é a primeira, no padrão já estabelecido do kanban.
  const user = useUser();
  const activeOrg = useActiveOrg();
  const podeCriarProposta =
    user.is_platform_admin || (activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager) || false;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
        // Observável pelo mesmo motivo do board: "a assinatura morreu" e "nada
        // aconteceu" têm a mesma aparência, que é silêncio.
        data-realtime-status={timeline.realtimeStatus.toLowerCase()}
        // Observável como no board: "a entrega morreu" e "nada aconteceu"
        // têm a mesma aparência, e no dossiê a segunda é ainda mais crível —
        // negócio sem novidade é um estado normal.
        data-refetch-divergencias={timeline.seguranca.divergencias}
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto sm:flex-row sm:overflow-hidden">
          {/* coluna esquerda: cabeçalho vivo + aba Principal */}
          <div className="flex w-full flex-col gap-0 overflow-y-auto border-b border-border p-6 sm:w-[22rem] sm:shrink-0 sm:border-r sm:border-b-0">
            <SheetHeader className="pb-3">
              <SheetTitle className="text-base leading-6">{lead.title}</SheetTitle>
            </SheetHeader>

            {/* ① cabeçalho vivo */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border pb-3 text-xs">
              <span className="font-medium tabular-nums text-text">
                {formatValor(lead.value_cents, lead.currency)}
              </span>
              <span className="text-text-muted">{stageName}</span>
              <OwnerBadge
                ownerKind={owner.kind}
                ownerName={owner.name}
                agentVersion={owner.agentVersion}
              />
              {score && (
                // O MESMO componente do card, não uma cópia do medidor.
                // "Superfície nova herda as decisões da antiga" só vale como
                // mecanismo: herdar por cópia é como as duas listas do evidence —
                // funciona hoje e diverge no mês em que alguém mudar um dos dois.
                // De brinde, o rótulo honesto da âncora ("registro que sustenta",
                // nunca "momento da conversa") vem junto, sem eu reescrever nada.
                <ScoreSlot
                  probability={score.probability}
                  band={score.band}
                  reason={score.reason}
                  factors={score.factors.slice(0, 3)}
                />
              )}

              <button
                type="button"
                onClick={() => campos.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
                className="ml-auto text-text-muted underline-offset-2 hover:text-text hover:underline"
              >
                {t("Editar campos")}
              </button>
            </div>

            {/* O score NÃO aparece na timeline: recálculo é telemetria e não emite
                atividade (silêncio para telemetria, pulso para mudança de estado).
                Sem esta linha, quem visse o número mudando no cabeçalho e nunca na
                timeline concluiria que a timeline está incompleta. */}
            {score?.at && (
              <p className="pt-2 text-[11px] text-text-muted">
                {t("Probabilidade recalculada automaticamente")} ·{" "}
                {new Date(score.at).toLocaleString(tagDoIdioma)}
              </p>
            )}

            <Tabs defaultValue="principal" className="mt-3">
              <TabsList>
                <TabsTrigger value="principal">{t("Principal")}</TabsTrigger>
              </TabsList>
              <TabsContent value="principal" className="flex flex-col gap-0">
                {/* Os dados do CLIENTE: telefone e e-mail numa aba, links (Instagram,
                    site, Google Meu Negócio…) na outra. Vêm do contato, não do lead. */}
                <section className="border-b border-border py-3">
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
                    {t("Contato")}
                  </h3>
                  <ContatoDoNegocio
                    contactId={lead.contact_id}
                    pipelineId={pipelineId}
                    leadId={lead.id}
                  />
                </section>

                {/* campos do negócio */}
                <div ref={campos} className="border-b border-border py-3">
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
                    {t("Dados do negócio")}
                  </h3>
                  <LeadFieldsForm lead={lead} pipelineId={pipelineId} fieldDefs={fieldDefs} />
                </div>

                {/* N1 — seção "Propostas", depois de "Dados do negócio". Some
                    sozinha (null) quando a capacidade está desligada — ver
                    PropostasDoNegocio. */}
                <PropostasDoNegocio
                  leadId={lead.id}
                  pipelineId={pipelineId}
                  podeCriar={podeCriarProposta}
                />
              </TabsContent>
            </Tabs>
          </div>

          {/* coluna direita: a conversa, depois a timeline — o que ACONTECEU,
              ao lado do card, sem disputar espaço com o formulário. */}
          <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-6">
            <ConversaNoDossie
              conversa={lead.conversa}
              contactId={lead.contact_id}
              phone={lead.contact_phone}
            />

            <section className="flex-1 pt-3">
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
                {t("Linha do tempo")}
              </h3>
              <LeadNoteComposer leadId={lead.id} />
              <LeadTimeline
                itens={timeline.itens}
                chegouAoVivo={timeline.chegouAoVivo}
                isLoading={timeline.isLoading}
                isError={timeline.isError}
              />
            </section>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
