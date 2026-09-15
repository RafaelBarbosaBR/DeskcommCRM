-- 0247_chamada_de_voz_wacalls
--
-- Chamada de voz pelo WhatsApp (WaCalls) — pareada por QR via whatsmeow,
-- INDEPENDENTE da sessão WAHA de mensagens do mesmo número. Servidor de
-- terceiro (Go + whatsmeow), a API interna que este schema serve.
--
-- POR QUE TABELA PRÓPRIA E NÃO UM 4º `channel_sessions.provider`:
-- `channel_sessions.provider` é CHECK fechado (waha/meta_cloud/zernio),
-- espelhado 1:1 em `lib/channels/types.ts` (ChannelProvider) e cobrado por
-- `tests/invariants/vocabulario-banco-x-typescript.test.ts`. Chamada de voz
-- não implementa `ChannelAdapter` — não manda mensagem, não tem
-- `send`/`resolveRecipient`/janela de 24h. Encaixar como 4º provider
-- inflaria esse contrato com um caso que não se aplica a ele. `wacalls_sessions`
-- é 1 linha por organização (organization_id como PK), sem FK de volta a
-- `channel_sessions` — nossa spec não precisa de "múltiplas sessões WaCalls
-- por org", diferente de WAHA.
--
-- DOIS EIXOS DE DESLIGADO, SEMPRE com `&&`, nunca com fallback um pro outro:
-- a instalação só oferece a feature se WACALLS_API_BASE_URL estiver setada
-- (decisão de quem administra a VPS); a organização só liga se um admin
-- aceitar o risco explicitamente (`org_voice_calls.enabled`, decisão de
-- negócio). `enabled` ausente/null = DESLIGADO — capacidade nova, sem
-- passado a preservar (ao contrário de org_guardrail_layers/0142, que
-- migrava instalação existente).

create table if not exists public.wacalls_sessions (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  wacalls_session_id text,
  wacalls_jid text,
  wacalls_paired_at timestamptz,
  -- Vocabulário do servidor de terceiro (`AuthSnapshot.State`, confirmado na
  -- fonte): 'connecting' (transitório, logo após criar a conta),
  -- 'qr' (esperando pareamento), 'open' (pareada), 'logged_out'.
  status text not null default 'connecting'
    check (status in ('connecting', 'qr', 'open', 'logged_out')),
  -- O QR muda a cada rodada (TTL curto do próprio WhatsApp) e só chega pelo
  -- stream SSE do servidor (`GET /api/events`, evento `session-qr`/
  -- `auth-state`) — não existe rota REST para "buscar o QR atual". O bridge
  -- do worker é quem mantém essa conexão viva e grava aqui o mais recente;
  -- esta coluna é o que a rota `GET /api/v1/voice/sessions` lê para a tela
  -- de pareamento renderizar sem manter conexão nenhuma aberta.
  qr text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_wacalls_sessions_active
  on public.wacalls_sessions (organization_id)
  where archived_at is null;

alter table public.wacalls_sessions enable row level security;

drop policy if exists wacalls_sessions_select on public.wacalls_sessions;
drop policy if exists wacalls_sessions_write on public.wacalls_sessions;

-- Mesmo corte de channel_sessions_tenant_select/write: leitura para todo
-- membro (a tela de conexões mostra status de pareamento a qualquer um),
-- escrita (parear/desparear) só admin+.
create policy wacalls_sessions_select on public.wacalls_sessions
  for select using (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

create policy wacalls_sessions_write on public.wacalls_sessions
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  );

revoke all on public.wacalls_sessions from anon;

drop trigger if exists trg_wacalls_sessions_set_updated_at on public.wacalls_sessions;
create trigger trg_wacalls_sessions_set_updated_at
  before update on public.wacalls_sessions
  for each row execute function public.fn_set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.voice_calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  wacalls_call_id text not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  peer_phone text not null,
  status text not null check (status in ('starting', 'ringing', 'connected', 'ended')),
  -- Vocabulário do servidor de terceiro (motivo de encerramento) — SEM CHECK
  -- de propósito (DIRC): quem grava é o bridge lendo o evento do WaCalls, e
  -- o servidor pode acrescentar motivo novo sem migration nossa para aceitar.
  end_reason text,
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration_ms integer,
  -- Quem está NA LINHA (atendeu/discou) — pode ficar null enquanto ninguém
  -- assume uma chamada entrando.
  owner_user_id uuid references auth.users(id) on delete set null,
  -- Quem discou; null em chamada inbound.
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, wacalls_call_id)
);

create index if not exists idx_voice_calls_org_started
  on public.voice_calls (organization_id, started_at desc);
create index if not exists idx_voice_calls_contact
  on public.voice_calls (organization_id, contact_id)
  where contact_id is not null;

alter table public.voice_calls enable row level security;

drop policy if exists voice_calls_select on public.voice_calls;
drop policy if exists voice_calls_write on public.voice_calls;

-- Leitura: todo membro — é histórico de contato com o cliente, mesmo raciocínio
-- de conversations/messages.
create policy voice_calls_select on public.voice_calls
  for select using (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

-- Escrita: agent+ — quem pode atender/discar. O bridge do worker usa o
-- service role (bypassa RLS); este gate é para a sessão do navegador
-- (aceitar/rejeitar/discar pela UI).
create policy voice_calls_write on public.voice_calls
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent'))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent'))
    or public.fn_is_platform_admin()
  );

revoke all on public.voice_calls from anon;

drop trigger if exists trg_voice_calls_set_updated_at on public.voice_calls;
create trigger trg_voice_calls_set_updated_at
  before update on public.voice_calls
  for each row execute function public.fn_set_updated_at();

-- Realtime é a fonte de verdade da UI de chamada (toque entrando, status
-- mudando em tempo real) — sem isto o painel de chamada ativa dependeria de
-- polling.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'voice_calls'
  ) then
    execute 'alter publication supabase_realtime add table public.voice_calls';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.org_voice_calls (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  -- Ausente/false = DESLIGADO. Não há `??` com env nenhuma: capacidade nova,
  -- sem instalação anterior para preservar.
  enabled boolean not null default false,
  risco_aceito_em timestamptz,
  risco_aceito_por uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.org_voice_calls enable row level security;

drop policy if exists org_voice_calls_select on public.org_voice_calls;
drop policy if exists org_voice_calls_write on public.org_voice_calls;

create policy org_voice_calls_select on public.org_voice_calls
  for select using (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

create policy org_voice_calls_write on public.org_voice_calls
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  );

revoke all on public.org_voice_calls from anon;

drop trigger if exists trg_org_voice_calls_set_updated_at on public.org_voice_calls;
create trigger trg_org_voice_calls_set_updated_at
  before update on public.org_voice_calls
  for each row execute function public.fn_set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────
-- Aviso na Central quando uma chamada entrando não é atendida por ninguém.
-- Lista reemitida INTEIRA (doutrina: uma constraint, um bloco) + o novo
-- valor no fim, antes de 'other'.
alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'appointment_outcome_required',
    'appointment_recovery_review',
    'qr_rescan',
    'routing_unassigned',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    'message_send_stuck',
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    'promise_unfulfilled',
    'contact_proposal_expired',
    'budget_warning',
    'conhecimento_nao_indexado',
    'appointment_recovery_exhausted',
    'voice_call_missed',
    'other'
  ));

-- `voice_call` (chamada ATENDIDA) entra na lista positiva de interação —
-- mesmo peso de `ai_turn`/`lead_edited`. `voice_call_missed` (chamada
-- PERDIDA) de propósito NÃO entra: telefone que tocou sem resposta é o
-- oposto de interação, e contar como toque zeraria o próprio relógio que
-- deveria acusar o silêncio.
create or replace function public.fn_update_last_activity_at()
  returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.type not in (
    'ai_turn',
    'note',
    'lead_edited',
    'stage_changed',
    'next_action_approved',
    'voice_call'
  ) then
    return new;
  end if;

  update public.crm_leads
     set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'::timestamptz), new.performed_at)
   where id = new.lead_id;

  if new.contact_id is not null then
    update public.contacts
       set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'::timestamptz), new.performed_at)
     where id = new.contact_id;
  end if;
  return new;
end$function$;

notify pgrst, 'reload schema';

-- `fn_attendant_metrics`: um CTE novo, `call_agg`, no mesmo molde de
-- `lead_agg`/`conv_agg`/`ttfr` — chamadas ATENDIDAS por atendente na janela,
-- contadas por quem estava na linha (`owner_user_id`), não por quem discou.
create or replace function public.fn_attendant_metrics(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_owner uuid default null
) returns jsonb
language sql stable
set search_path = public
as $$
  with
  lead_agg as (
    select
      owner_user_id as user_id,
      count(*) filter (where status = 'won')  as won,
      count(*) filter (where status = 'lost') as lost
    from public.crm_leads
    where organization_id = p_org
      and status in ('won', 'lost')
      and closed_at >= p_from and closed_at < p_to
      and owner_user_id is not null
      and (p_owner is null or owner_user_id = p_owner)
    group by owner_user_id
  ),
  conv_agg as (
    select
      assigned_to_user_id as user_id,
      count(*) as conversations_handled
    from public.conversations
    where organization_id = p_org
      and assigned_to_user_id is not null
      and assigned_at >= p_from and assigned_at < p_to
      and (p_owner is null or assigned_to_user_id = p_owner)
    group by assigned_to_user_id
  ),
  ttfr as (
    select
      c.assigned_to_user_id as user_id,
      avg(extract(epoch from (fr.first_human_out - fr.first_in))) as avg_first_response_seconds
    from public.conversations c
    cross join lateral (
      select
        min(m.sent_at) filter (where m.direction = 'inbound') as first_in,
        min(m.sent_at) filter (
          where m.direction = 'outbound' and m.sent_by_user_id is not null
        ) as first_human_out
      from public.messages m
      where m.conversation_id = c.id
    ) fr
    where c.organization_id = p_org
      and c.assigned_to_user_id is not null
      and (p_owner is null or c.assigned_to_user_id = p_owner)
      and fr.first_in is not null
      and fr.first_human_out is not null
      and fr.first_human_out > fr.first_in
      and fr.first_human_out >= p_from and fr.first_human_out < p_to
    group by c.assigned_to_user_id
  ),
  call_agg as (
    select
      owner_user_id as user_id,
      count(*) filter (where status = 'ended' and answered_at is not null) as calls_answered,
      coalesce(sum(duration_ms) filter (where status = 'ended' and answered_at is not null), 0) as calls_duration_ms
    from public.voice_calls
    where organization_id = p_org
      and started_at >= p_from and started_at < p_to
      and owner_user_id is not null
      and (p_owner is null or owner_user_id = p_owner)
    group by owner_user_id
  ),
  attendant_ids as (
    select user_id from lead_agg
    union select user_id from conv_agg
    union select user_id from ttfr
    union select user_id from call_agg
  )
  select jsonb_build_object(
    'funnel', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'stage_id', s.id,
          'stage_name', s.name,
          'position', s.position,
          'count', coalesce(l.cnt, 0)
        ) order by s.position, s.name
      )
      from public.crm_stages s
      left join (
        select stage_id, count(*) as cnt
        from public.crm_leads
        where organization_id = p_org
          and status = 'open'
          and (p_owner is null or owner_user_id = p_owner)
        group by stage_id
      ) l on l.stage_id = s.id
      where s.organization_id = p_org
        and s.is_archived = false
    ), '[]'::jsonb),
    'attendants', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'user_id', a.user_id,
          'won', coalesce(la.won, 0),
          'lost', coalesce(la.lost, 0),
          'conversations_handled', coalesce(ca.conversations_handled, 0),
          'avg_first_response_seconds', tf.avg_first_response_seconds,
          'calls_answered', coalesce(cga.calls_answered, 0),
          'calls_duration_ms', coalesce(cga.calls_duration_ms, 0)
        ) order by coalesce(la.won, 0) desc, a.user_id
      )
      from attendant_ids a
      left join lead_agg la on la.user_id = a.user_id
      left join conv_agg ca on ca.user_id = a.user_id
      left join ttfr tf on tf.user_id = a.user_id
      left join call_agg cga on cga.user_id = a.user_id
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.fn_attendant_metrics(uuid, timestamptz, timestamptz, uuid) from public;
revoke execute on function public.fn_attendant_metrics(uuid, timestamptz, timestamptz, uuid) from anon;
grant execute on function public.fn_attendant_metrics(uuid, timestamptz, timestamptz, uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';

-- `fn_lgpd_cascade_redact_contact`: passo 10, `voice_calls` — mesmo padrão de
-- `orders`/`touchpoints` (soft de-link de `contact_id` + limpeza do que é PII
-- da PESSOA). `peer_phone` é o número discado/que discou — igual a
-- `phone_number` em `contacts`. `owner_user_id`/`created_by` NÃO são tocados:
-- identificam o ATENDENTE, não o contato redigido.
create or replace function public.fn_lgpd_cascade_redact_contact(p_organization_id uuid, p_contact_id uuid, p_request_id uuid) returns jsonb
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_already bool;
  v_counts jsonb := '{}'::jsonb;
  v_media_paths text[] := '{}';
  v_anon_label text;
  v_count int;
begin
  perform public.fn_service_lock(p_organization_id,p_contact_id);
  select is_anonymized into v_already
    from contacts
    where id = p_contact_id and organization_id = p_organization_id;

  if not found then
    raise exception 'contact not found' using errcode = 'P0002';
  end if;

  if v_already then
    return jsonb_build_object('already_anonymized', true, 'counts', v_counts, 'media_paths', v_media_paths);
  end if;

  v_anon_label := 'Cliente Anonimizado #' || substring(p_contact_id::text from 1 for 8);

  select coalesce(array_agg(distinct media_storage_path) filter (where media_storage_path is not null), '{}')
    into v_media_paths
    from messages
    where organization_id = p_organization_id
      and conversation_id in (
        select id from conversations
          where contact_id = p_contact_id and organization_id = p_organization_id
      );

  update contacts set
    name = v_anon_label,
    display_name = v_anon_label,
    email = null,
    phone_number = null,
    cpf_encrypted = null,
    cpf_hash = null,
    birthdate = null,
    is_anonymized = true,
    anonymized_at = now(),
    consent = '{}'::jsonb,
    source_metadata = '{}'::jsonb,
    tags = '{}'::text[],
    updated_at = now()
  where id = p_contact_id and organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('contacts', v_count);

  update conversations set
    metadata = '{}'::jsonb,
    last_message_preview = null,
    updated_at = now()
  where contact_id = p_contact_id and organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('conversations', v_count);

  update messages set
    body = '[mensagem anonimizada]',
    media_url = null,
    media_mime = null,
    media_size_bytes = null,
    media_storage_path = null,
    metadata = '{}'::jsonb,
    updated_at = now()
  where organization_id = p_organization_id
    and conversation_id in (
      select id from conversations
        where contact_id = p_contact_id and organization_id = p_organization_id
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('messages', v_count);

  update crm_lead_activities set
    payload = '{}'::jsonb,
    metadata = '{}'::jsonb,
    reason = null
  where organization_id = p_organization_id
    and (
      contact_id = p_contact_id
      or lead_id in (
        select lead_id from crm_lead_links
          where target_kind = 'contact'
            and target_id = p_contact_id
            and organization_id = p_organization_id
      )
      or lead_id in (
        select id from crm_leads
          where contact_id = p_contact_id and organization_id = p_organization_id
      )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('activities', v_count);

  update crm_leads set
    title = v_anon_label,
    description = null,
    custom_fields = '{}'::jsonb,
    source_metadata = '{}'::jsonb,
    tags = '{}'::text[],
    updated_at = now()
  where organization_id = p_organization_id
    and (
      contact_id = p_contact_id
      or id in (
        select lead_id from crm_lead_links
          where target_kind = 'contact'
            and target_id = p_contact_id
            and organization_id = p_organization_id
      )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('leads', v_count);

  update orders set
    payload = (coalesce(payload, '{}'::jsonb))
      - 'customer'
      - 'customer_name'
      - 'customer_email'
      - 'customer_phone'
      - 'shipping_address'
      - 'billing_address'
      - 'contact_identification',
    customer_external_id = null,
    contact_id = null,
    is_anonymized = true,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('orders', v_count);

  -- 9. touchpoints — soft de-link (mesmo padrão de `orders`) + limpeza de
  --    URL/referrer/utm_content. fbclid/gclid/utm_source/medium/campaign/term
  --    ficam: são atribuição de CAMPANHA, não da pessoa, e o link com ela já
  --    foi cortado por este mesmo passo.
  update touchpoints set
    contact_id = null,
    url = null,
    referrer = null,
    utm_content = null
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('touchpoints', v_count);

  -- 10. voice_calls — soft de-link (mesmo padrão de `orders`/`touchpoints`) +
  --     limpeza do número. `owner_user_id`/`created_by` ficam: identificam o
  --     ATENDENTE, não o contato redigido.
  update voice_calls set
    contact_id = null,
    peer_phone = '[redigido]',
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('voice_calls', v_count);

  if array_length(v_media_paths, 1) > 0 then
    insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
    select p_organization_id, p_request_id, 'whatsapp-media', path
      from unnest(v_media_paths) as path
      where path is not null and length(path) > 0
    on conflict (bucket, object_path) do nothing;
  end if;

  insert into api_audit_log (organization_id, action, actor_user_id, resource_type, resource_id, metadata, bypassed_rls)
  values (
    p_organization_id,
    'lgpd.redact_executed',
    null,
    'contact',
    p_contact_id,
    jsonb_build_object(
      'cascaded_to', v_counts,
      'media_queued', coalesce(array_length(v_media_paths, 1), 0),
      'request_id', p_request_id
    ),
    true
  );

  return jsonb_build_object(
    'already_anonymized', false,
    'counts', v_counts,
    'media_paths', v_media_paths
  );
end;
$$;

revoke all on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) to service_role;

notify pgrst, 'reload schema';
