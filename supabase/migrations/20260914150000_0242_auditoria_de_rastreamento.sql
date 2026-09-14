-- 0242 — auditoria de rastreamento: fila de retry com backoff, log bruto por
-- plataforma, e expurgo técnico
--
-- Três peças:
--
--   1. `outbound_events` ganha o que faltava pra ser uma fila de retry de
--      verdade: `attempt_count`/`last_attempt_at`/`next_retry_at`/
--      `error_message`. O vocabulário de status muda de
--      pending/sent/accepted/rejected pra pending/processing/sent/failed/
--      dead_letter — `processing` é o CLAIM otimista por linha (uma linha por
--      evento×provider; o claim do event_log é por evento inteiro, e não
--      protege o fan-out se o processo morrer no meio de 3 providers) e
--      `dead_letter` é "esgotou as tentativas", nunca "a plataforma recusou"
--      sozinho — as duas causas (recusa e esgotamento) convergem pro mesmo
--      status porque as DUAS têm o mesmo próximo passo: alguém olhar.
--
--   2. `platform_event_logs` é NOVO — o histórico BRUTO de cada tentativa,
--      por plataforma, sanitizado. Não existia nada assim: `meta_event_logs`
--      (migration 0234) é um upsert de ESTADO ATUAL por evento, uma linha só,
--      só pra Meta. Isto aqui é append-only, cross-provider, uma linha POR
--      TENTATIVA — é o que a tela de auditoria precisa pra mostrar "o que
--      aconteceu de verdade a cada chamada", e `meta_event_logs` continua
--      existindo do lado dele, sem mudar: é o dedup Pixel×CAPI, outro
--      propósito.
--
--   3. Duas funções de expurgo BATCHED, mesmo molde de `fn_podar_fila_de_jobs`
--      (migration 0187/0261): security definer, `greatest(piso)`,
--      `limit`+`get diagnostics row_count`. `platform_event_logs` é log
--      técnico puro — sempre podável, sem condição de "ainda em andamento".
--      `outbound_events` só poda status TERMINAL (`sent`/`dead_letter`); uma
--      linha em `pending`/`processing` nunca é candidata, não importa a
--      idade — apagar uma linha que ainda vai tentar de novo faria o
--      próximo tick da fila recriá-la do zero, perdendo `attempt_count` e o
--      histórico de erro que é exatamente o que a auditoria existe pra
--      mostrar.
--
-- `internal_events` (o registro de conversão em si) NÃO GANHA EXPURGO —
-- de propósito, e é o princípio 3 do pedido: é histórico COMERCIAL, não log
-- técnico. Continua sem função de poda nenhuma, igual desde a 0234.

-- ── outbound_events: colunas de retry + vocabulário de status ───────────────

alter table public.outbound_events
  add column if not exists attempt_count integer not null default 0,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists next_retry_at timestamptz,
  add column if not exists error_message text;

-- Backfill ANTES de trocar a constraint — as duas próximas linhas são idempotentes
-- (rodar de novo não muda nada: não sobra `accepted`/`rejected` depois da 1ª vez).
update public.outbound_events set status = 'sent' where status = 'accepted';
update public.outbound_events set status = 'failed' where status = 'rejected';

alter table public.outbound_events
  drop constraint if exists outbound_events_status_enum;
alter table public.outbound_events
  add constraint outbound_events_status_enum
  check (status in ('pending', 'processing', 'sent', 'failed', 'dead_letter'));

comment on column public.outbound_events.attempt_count is
  'Quantas tentativas de envio já foram feitas (sucesso ou falha, conta as duas). Base do backoff e do teto de tentativas.';
comment on column public.outbound_events.last_attempt_at is
  'Quando a ÚLTIMA tentativa rodou — sucesso ou falha. Distinto de created_at (quando a linha nasceu) e de sent_at (só existe se deu certo).';
comment on column public.outbound_events.next_retry_at is
  'Quando a PRÓXIMA tentativa está agendada. NULL = não há próxima (terminal: sent ou dead_letter; ou ainda não tentou nenhuma vez e o despacho imediato é quem tenta).';
comment on column public.outbound_events.error_message is
  'A mensagem de erro REAL da tentativa mais recente — da API da plataforma quando ela respondeu, ou do motivo de não ter tentado (sem credencial, etc). Nunca um texto genérico inventado aqui.';

-- Índice do VARREDOR de retry: status='pending' é o filtro seletivo (poucas
-- linhas), next_retry_at entra no mesmo índice pra evitar um segundo acesso.
create index if not exists outbound_events_retry_idx
  on public.outbound_events (next_retry_at)
  where status = 'pending';

-- Índice do REAPER de `processing` preso (mesma razão do event_log: um
-- processo que morre no meio de uma chamada de rede deixaria a linha travada
-- pra sempre sem isto).
create index if not exists outbound_events_processing_idx
  on public.outbound_events (last_attempt_at)
  where status = 'processing';

-- ── platform_event_logs: histórico bruto, sanitizado, por tentativa ─────────

create table if not exists public.platform_event_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  outbound_event_id uuid not null references public.outbound_events(id) on delete cascade,
  internal_event_id uuid not null references public.internal_events(id) on delete cascade,
  provider text not null,
  event_name text,
  status text not null,
  -- SANITIZADO antes de chegar aqui (lib/rastreamento/motor/sanitizar-log.ts):
  -- nunca token, nunca segredo, PII já hasheada. Esta tabela é auditoria, não
  -- pode virar um segundo lugar pra vazar o que `secrets_encrypted` protege.
  error_message text,
  response_summary jsonb not null default '{}'::jsonb,
  attempted_at timestamptz not null default now(),
  constraint platform_event_logs_provider_enum
    check (provider in ('META', 'GA4', 'GOOGLE_ADS')),
  constraint platform_event_logs_status_enum
    check (status in ('ok', 'erro'))
);

create index if not exists platform_event_logs_org_time_idx
  on public.platform_event_logs (organization_id, attempted_at desc);

create index if not exists platform_event_logs_status_idx
  on public.platform_event_logs (organization_id, status, attempted_at desc);

comment on table public.platform_event_logs is
  'Histórico BRUTO de cada tentativa de envio a uma plataforma — append-only, uma linha por chamada, sanitizado (nunca segredo, PII hasheada). Diferente de meta_event_logs (upsert de estado atual, só Meta, dedup Pixel×CAPI). Expurgado depois de alguns dias por fn_podar_platform_event_logs — é log técnico, não histórico comercial.';

alter table public.platform_event_logs enable row level security;
revoke all on public.platform_event_logs from anon, authenticated;
grant select, insert, update, delete on public.platform_event_logs to service_role;

-- ── expurgo batched — mesmo molde de fn_podar_fila_de_jobs (0187/0261) ──────

create or replace function public.fn_podar_platform_event_logs(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Piso de 3 dias: abaixo disso a auditoria mostraria "sem nada" pra quem
  -- investiga um erro de ontem, que é o caso de uso nº 1 desta tabela.
  v_dias int := greatest(coalesce(p_retencao_dias, 7), 3);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_apagadas int;
begin
  with vencidas as (
    select l.id
      from public.platform_event_logs l
     where l.attempted_at < now() - make_interval(days => v_dias)
     order by l.attempted_at
     limit v_limite
  )
  delete from public.platform_event_logs l
   using vencidas v
   where l.id = v.id;
  get diagnostics v_apagadas = row_count;
  return v_apagadas;
end;
$$;

create or replace function public.fn_podar_outbound_events_finalizados(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dias int := greatest(coalesce(p_retencao_dias, 7), 3);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_apagados int;
begin
  -- SÓ status terminal. Uma linha pending/processing/failed-aguardando-retry
  -- nunca é candidata, não importa a idade — apagá-la perderia
  -- attempt_count/error_message no meio de uma tentativa que ainda vai
  -- acontecer, e o próximo tick da fila a recriaria do zero.
  with vencidos as (
    select o.id
      from public.outbound_events o
     where o.status in ('sent', 'dead_letter')
       and o.created_at < now() - make_interval(days => v_dias)
     order by o.created_at
     limit v_limite
  )
  delete from public.outbound_events o
   using vencidos v
   where o.id = v.id;
  get diagnostics v_apagados = row_count;
  return v_apagados;
end;
$$;

revoke execute on function public.fn_podar_platform_event_logs(int, int)
  from public, anon, authenticated;
grant  execute on function public.fn_podar_platform_event_logs(int, int)
  to service_role;

revoke execute on function public.fn_podar_outbound_events_finalizados(int, int)
  from public, anon, authenticated;
grant  execute on function public.fn_podar_outbound_events_finalizados(int, int)
  to service_role;

notify pgrst, 'reload schema';
