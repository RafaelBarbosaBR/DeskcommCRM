"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useRef } from "react";

import { useT } from "@/hooks/i18n/useT";
import { useActiveOrg, usePermission, useUser } from "@/hooks/auth/AuthProvider";
import { ROLE_RANK } from "@/lib/auth/types";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLeadTimeline } from "@/hooks/leads/useLeadTimeline";
import type { Lead } from "@/lib/types/leads";
import type { Stage } from "@/lib/kanban/types";
import { ContatoDoNegocio } from "./ContatoDoNegocio";
import { ConversaNoDossie } from "./ConversaNoDossie";
import { LeadFieldsForm, type ControleDosCamposDoNegocio } from "./LeadFieldsForm";
import { RevisaoDoDocumento } from "./RevisaoDoDocumento";
import { ScoreSlot } from "./ScoreSlot";
import { LeadNoteComposer } from "./LeadNoteComposer";
import { LeadTimeline } from "./LeadTimeline";
import { PropostasDoNegocio } from "./PropostasDoNegocio";
import { TarefasDoNegocio } from "./TarefasDoNegocio";
import { OwnerBadge } from "./OwnerBadge";
import { EtapaNoDossie } from "./EtapaNoDossie";
import { useSecoesRecolhidas } from "./SecaoDoDossie";
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
  /**
   * As etapas do funil e quem move. Presentes (o quadro passa), o cabeçalho
   * troca o nome da etapa por um seletor — ver `EtapaNoDossie`. Ausentes (o
   * calendário, por enquanto), fica o texto de antes.
   */
  etapas?: Pick<Stage, "id" | "name">[];
  onMudarEtapa?: (stageId: string) => void;
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
 * paleta escura de referência). Decisão desta instalação, mantida na
 * atualização para a 1.94 por cima do redesenho de colunas única (#3181) que
 * o upstream fez no mesmo período — as DUAS mexiam na mesma tela por motivos
 * diferentes, e o layout em colunas é o que esta operação pediu e já usa.
 *
 * Esquerda (estreita, rola sozinha): cabeçalho vivo, a aba "Principal" com
 * Contato, os campos do negócio (com a fila de revisão do documento, #3415) e
 * Propostas. Direita (larga, rola sozinha): tarefas, a linha do tempo (com o
 * campo de comentário manual) e o atalho para a conversa.
 *
 * SÓ "Principal" existe como aba por agora — não há tela de Estatísticas,
 * Mídia nem catálogo de Produtos por negócio ainda; uma aba vazia mentiria
 * sobre o que o produto faz. A aba fica pronta para quando (se) essas telas
 * existirem.
 *
 * A ORDEM DENTRO DA COLUNA DIREITA preserva a decisão de 16/10: quem abre um
 * lead quer primeiro saber O QUE ACONTECEU — tarefas e timeline, que não
 * disputam espaço com o formulário por morarem na coluna própria.
 *
 * O RECOLHIMENTO DA TIMELINE (#3181, upstream) sobrevive sem o resto do
 * redesenho dele: a seção mostra as `ENTRADAS_COM_A_LINHA_RECOLHIDA` mais
 * recentes com "Ver tudo", usando o MESMO `useSecoesRecolhidas` (estado por
 * navegador, em `localStorage`) — só não está dentro de um `SecaoDoDossie`
 * genérico, porque as outras seções desta coluna não colapsam.
 *
 * SALVAR NÃO FECHA. Quem edita precisa ver a atividade que acabou de gerar
 * entrar na timeline; fechar esconderia o registro justamente de quem o
 * produziu, e a funcionalidade que prova "sua ação fica registrada" provaria
 * isso para todo mundo menos para o autor.
 */

/** Quantas entradas a linha do tempo mostra com a seção recolhida (#3181). */
const ENTRADAS_COM_A_LINHA_RECOLHIDA = 3;

export function LeadDossier({
  open,
  onOpenChange,
  lead,
  pipelineId,
  fieldDefs = [],
  stageName,
  ownerNames,
  etapas,
  onMudarEtapa,
}: Props) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const campos = useRef<HTMLDivElement | null>(null);
  const formulario = useRef<ControleDosCamposDoNegocio | null>(null);
  const timeline = useLeadTimeline(open ? lead.id : null, lead.contact_id);
  const { fechadas, alternar } = useSecoesRecolhidas();
  const timelineRecolhida = fechadas.has("linha-do-tempo");
  // As três MAIS RECENTES: a rota devolve `performed_at` decrescente, então o
  // corte é no início da lista, não no fim.
  const itensDaTimeline = timelineRecolhida
    ? timeline.itens.slice(0, ENTRADAS_COM_A_LINHA_RECOLHIDA)
    : timeline.itens;
  const temMaisNaTimeline = timeline.itens.length > ENTRADAS_COM_A_LINHA_RECOLHIDA;
  const owner = resolveLeadOwner(lead, ownerNames);
  const score = lead.score ?? null;
  // N1 — o atalho "Nova proposta" é manager+ (mesmo gate do envio, mesma
  // régua do BulkActionBar). O dossiê não tinha nenhuma checagem de papel;
  // esta é a primeira, no padrão já estabelecido do kanban.
  const user = useUser();
  const activeOrg = useActiveOrg();
  const podeCriarProposta =
    user.is_platform_admin || (activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager) || false;
  // A MESMA régua do arrasto e do "Mover para…" do card (`KanbanCardActions`).
  const podeMoverCard = usePermission("pipeline.move_card");
  // Tarefas são `agent`+, a mesma régua da tela de Tarefas e da rota — e o
  // suporte temporário só lê, como lá (`requireSupportWrite`).
  const podeEditarTarefas =
    (user.is_platform_admin && !user.support) ||
    (activeOrg ? ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent : false);
  // Confirmar o que o documento disse é EDITAR O CARD: `agent`+, a MESMA régua
  // que a rota de decisão exige (`requireRole("agent")`). Abaixo disso a fila
  // ainda aparece — ler o que a IA leu é informação —, mas sem os botões.
  const podeConfirmarDoDocumento = podeEditarTarefas;

  /**
   * As props da linha do tempo, montadas UMA vez e usadas nos dois estados da
   * seção. Duplicar o bloco seria a maneira mais fácil de os dois divergirem —
   * e o recolhido é justamente o estado menos olhado por quem revisa.
   *
   * São as props, e não o elemento da linha do tempo já montado numa variável
   * lá em cima: `tests/unit/dossie-atalho-conversa` prova que o bloco da
   * conversa aparece ANTES da linha do tempo lendo a posição do primeiro
   * elemento dela no arquivo, e uma variável içada para o topo do componente
   * inverteria essa leitura sem nada ter mudado na tela — o teste passaria a
   * medir a posição de uma variável, e não da seção.
   */
  const propsDaLinhaDoTempo = {
    itens: itensDaTimeline,
    chegouAoVivo: timeline.chegouAoVivo,
    isLoading: timeline.isLoading,
    isError: timeline.isError,
  };

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
              {etapas && onMudarEtapa ? (
                <EtapaNoDossie
                  etapaAtual={lead.stage_id}
                  etapas={etapas}
                  podeMover={podeMoverCard}
                  onMudar={onMudarEtapa}
                />
              ) : (
                <span className="text-text-muted">{stageName}</span>
              )}
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

                {/* campos do negócio — `data-secao` é o MESMO atributo que
                    `SecaoDoDossie` usa (#3316): quem procura "a seção dos
                    campos" não precisa saber se ela colapsa ou não. */}
                <div ref={campos} data-secao="dados-do-negocio" className="border-b border-border py-3">
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
                    {t("Dados do negócio")}
                  </h3>
                  {/* ⚠️ A REVISÃO FICA AQUI, dentro do card — a fila existia como
                      API e não tinha consumidor na tela (#3415). Acima do
                      formulário porque é o histórico do que o documento disse, e
                      o formulário é o destino do que for confirmado. */}
                  <RevisaoDoDocumento
                    leadId={lead.id}
                    podeDecidir={podeConfirmarDoDocumento}
                    aoDecidir={(confirmado) => formulario.current?.confirmarCampo(confirmado)}
                  />
                  <LeadFieldsForm
                    lead={lead}
                    pipelineId={pipelineId}
                    fieldDefs={fieldDefs}
                    controle={formulario}
                  />
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

          {/* coluna direita: tarefas, a timeline (com o comentário) e por
              último a conversa (16/10) — inverte a ordem anterior (conversa
              primeiro). O comentário é o que se escreve o tempo todo, e
              precisa estar visível SEM rolar; a conversa é a porta de saída
              para outro lugar, e cabe mais abaixo, sem disputar o topo com o
              que se usa a cada abertura do dossiê. */}
          <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-6">
            {/* As tarefas SEGUEM antes da linha do tempo: a timeline conta o
                que já aconteceu, a tarefa é o que ainda falta fazer — e quem
                abre o card para agir procura o próximo passo primeiro. */}
            <TarefasDoNegocio
              leadId={lead.id}
              contactId={lead.contact_id}
              podeEditar={podeEditarTarefas}
              aberto={open}
            />

            {/* Linha do tempo — recolhida, mostra as três entradas mais
                recentes e o "ver tudo" (#3181, upstream): a seção fecha sem
                deixar a pergunta "e o que aconteceu por último?" sem
                resposta. O comentário manual (16/10) fica logo abaixo dela,
                sempre visível, recolhida ou não. */}
            <section className="flex-1">
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
                {t("Linha do tempo")}
              </h3>
              <LeadTimeline {...propsDaLinhaDoTempo} />
              {temMaisNaTimeline && (
                <button
                  type="button"
                  onClick={() => alternar("linha-do-tempo")}
                  className="mt-2 text-xs text-text-muted underline-offset-2 hover:text-text hover:underline"
                >
                  {t("Ver tudo")}
                </button>
              )}
              <LeadNoteComposer leadId={lead.id} />
            </section>

            <ConversaNoDossie
              conversa={lead.conversa}
              contactId={lead.contact_id}
              phone={lead.contact_phone}
            />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
