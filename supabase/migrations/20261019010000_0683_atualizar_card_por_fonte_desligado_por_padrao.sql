-- manifest: Atualizar o card quando o `external_id` já existe passa a ser OPÇÃO POR FONTE, desligada por padrão (issue #2316) e só ligável em fonte com segredo; `crm_leads.webhook_source_id` carimba a fonte que CRIOU o card (durável, backfill do `source_metadata`) e a atualização só alcança o card da mesma fonte; na mesma passada o CHECK de `webhook_lead_captures.outcome` aceita `atualizado`, o que aposenta a ponte de `registrarCaptacao`.
--
-- 0683: a atualização de card por integração é uma opção da fonte (#2316).
--
-- Detalhe completo no cabeçalho do bloco abaixo; o bloco é o MESMO, letra a
-- letra, no apêndice de `supabase/baseline.sql` — é ele que o `update.sh`
-- reaplica a cada atualização, inclusive em quem nunca vai rodar migrations.

-- ---- atualizar o card pela integração é opção da fonte (migration 0683, #2316) ----
-- O webhook de entrada passou a ATUALIZAR o card quando chega um `external_id`
-- repetido com dado novo (#2316) — o valor pago, a área, a etapa da integração
-- de diagnóstico. Como estava, a régua valia para TODA fonte de TODA instalação,
-- e isso inclui um efeito que ninguém pediu: o vendedor que corrige o título ou
-- um campo do card à mão e depois recebe um retry (ou um evento antigo) da
-- ferramenta tem a edição SOBRESCRITA, porque a comparação é com o valor atual.
--
-- O desenho é o da própria issue: a atualização é uma OPÇÃO DA FONTE, e ela
-- nasce DESLIGADA. Quem não liga fica exatamente como estava antes do #2316 —
-- reenvio continua sendo reenvio (`duplicado`), sem tocar no card.
--
-- ─── Por que `crm_leads.webhook_source_id`, e não o histórico ──────────────
--
-- Saber de QUEM é o card é o que impede a fonte A de reescrever o card que
-- nasceu na fonte B (a busca é por organização + `external_id`). O caminho
-- barato seria a linha `criado` em `webhook_lead_captures`, e ele não serve:
-- aquela tabela é PODADA (365 dias por padrão, migration 0174) e não existe
-- para os leads anteriores a ela — a pergunta "de quem é este card?" voltaria
-- sem resposta justamente nos cards velhos, que são os que mais têm edição
-- manual em cima. A coluna é durável e tipada.
--
-- O backfill sai do `source_metadata ->> 'webhook_source_id'`, que a rota grava
-- desde sempre — a coluna passa a ser a autoridade, e nenhum card já existente
-- fica sem a resposta. Genérico: casa pelo `organization_id` da fonte, nunca por
-- id de tenant.
--
-- ─── Por que NÃO há CHECK exigindo segredo para ligar a opção ──────────────
--
-- "Atualizar card é integração entre sistemas, e o formulário HTML público não
-- precisa disso" — a regra é exigida na BORDA (`assinaturaObrigatoriaAusente`,
-- a MESMA função que já guarda a autorização de IA), como a opção irmã. Um
-- CHECK aqui teria o efeito colateral oposto: uma fonte com a opção ligada não
-- conseguiria mais REMOVER o segredo, e a tela promete o contrário ("desligue
-- primeiro a autorização"). O índice único de negócio fica onde o produto o lê.
--
-- ─── O CHECK do desfecho, na mesma passada ─────────────────────────────────
--
-- `atualizado` foi o vocabulário novo do #2316, e ele não cabia no CHECK da
-- 0174 — daí a ponte que regravava a linha como `duplicado` para ela não sumir
-- da tela "Leads recebidos". Alargar o CHECK agora aposenta a ponte e faz a tela
-- mostrar o desfecho VERDADEIRO. O `do $$` só troca a constraint quando ela
-- ainda não conhece o valor: reaplicar o baseline num clone atualizado não
-- dispara DDL nenhuma.

alter table public.webhook_sources
  add column if not exists update_existing_lead_on_capture boolean not null default false;

comment on column public.webhook_sources.update_existing_lead_on_capture is
  'Opção da fonte (issue #2316), DESLIGADA por padrão: quando um envio chega com um external_id que já existe, o card da MESMA fonte é atualizado com os campos novos e a etapa pedida, em vez de o envio ser descartado como reenvio. Só liga em fonte com segredo configurado (régua da borda, a mesma da autorização de IA) — é integração entre sistemas, não formulário HTML público.';

alter table public.crm_leads
  add column if not exists webhook_source_id uuid references public.webhook_sources(id) on delete set null;

comment on column public.crm_leads.webhook_source_id is
  'Fonte de webhook que CRIOU este card (issue #2316). DURÁVEL por desenho: a linha de webhook_lead_captures é podada (365 dias) e não existe para leads antigos, e é esta coluna que responde "de quem é este card" para a atualização por integração só alcançar o card da própria fonte. NULL = card que não nasceu de webhook (ou anterior à coluna e sem source_metadata).';

-- A fonte de ORIGEM do card, para quem já está no banco: a rota grava
-- `source_metadata.webhook_source_id` desde sempre, e a coluna passa a ser a
-- autoridade. Idempotente: só preenche o que está nulo.
update public.crm_leads l
   set webhook_source_id = s.id
  from public.webhook_sources s
 where l.webhook_source_id is null
   and l.source = 'webhook'
   and l.organization_id = s.organization_id
   and l.source_metadata ->> 'webhook_source_id' = s.id::text;

create index if not exists crm_leads_webhook_source_idx
  on public.crm_leads (webhook_source_id)
  where webhook_source_id is not null;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.webhook_lead_captures'::regclass
       and conname = 'webhook_lead_captures_outcome_check'
       and pg_get_constraintdef(oid) like '%''atualizado''%'
  ) then
    -- Drop e add na MESMA transação: se o add falhar, o drop desfaz junto.
    alter table public.webhook_lead_captures
      drop constraint if exists webhook_lead_captures_outcome_check;
    alter table public.webhook_lead_captures
      add constraint webhook_lead_captures_outcome_check
      check (outcome = any (array['criado'::text, 'duplicado'::text, 'recusado'::text,
                                  'atualizado'::text]));
  end if;
end $$;

comment on column public.webhook_lead_captures.outcome is
  'criado = virou lead novo; duplicado = envio repetido, nada mudou no card; atualizado = o card da mesma fonte recebeu o dado novo (issue #2316, só com a opção da fonte ligada); recusado = não entrou (reject_reason diz por quê).';

notify pgrst, 'reload schema';
