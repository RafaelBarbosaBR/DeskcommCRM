-- 0663 — regras de atendimento POR NÚMERO (canal): modo de distribuição e destino padrão.
--
-- manifest: modo de distribuição (manual/rodízio/carga) e atendente de destino padrão POR NÚMERO, em channel_routing_policies; nulo = herda o comportamento da organização.
--
-- ─── Por que aqui, e o que já existia ───────────────────────────────────────
--
-- O MODO de distribuição mora em `organizations.settings.routing.mode` — UM só
-- para a empresa. Quem tem números diferentes para setores diferentes (o número
-- oficial com triagem por IA e rodízio, e um segundo número, conectado por QR
-- Code, entregando tudo a uma pessoa específica) não consegue. Issue #2331.
--
-- A tabela `public.channel_routing_policies` (migration 0228) JÁ guarda a linha
-- por canal, com os responsáveis em `channel_routing_responsibles` — ela nasceu
-- para RESTRINGIR quem pode receber o rodízio daquele número. Esta migration
-- ACRESCENTA duas colunas à MESMA linha, sem inventar tabela nova:
--
--   distribution_mode         — o modo do número (manual|round_robin|load).
--                               NULL = o número NÃO tem regra própria: cai no
--                               comportamento da organização.
--   default_assignee_user_id  — o atendente de destino padrão do número.
--                               Preenchido, a conversa vai DIRETO para ele,
--                               antes de qualquer distribuição. NULL = sem
--                               destino padrão; o modo decide.
--
-- As DUAS colunas nulas são o contrato de compatibilidade: toda policy criada
-- até aqui já nasce com as duas nulas e continua se comportando como antes.
--
-- ─── Reuso (não recriar) ─────────────────────────────────────────────────────
--
-- Cor, telefone e status do canal continuam em `channel_sessions`; o número de
-- destino padrão é só a referência à coluna nova. Nada de enum novo em pg: a
-- lista de modos é a MESMA de `lib/schemas/routing.ts` (ROUTING_MODES) e a
-- validação canônica é o CHECK abaixo; a RPC repete a checagem para dar erro
-- legível antes de gravar.

alter table public.channel_routing_policies
  add column if not exists distribution_mode text;
alter table public.channel_routing_policies
  add column if not exists default_assignee_user_id uuid;

-- Só os três modos que a tela oferece. Nulo = herda a organização (o padrão).
alter table public.channel_routing_policies
  drop constraint if exists channel_routing_policies_distribution_mode_check;
alter table public.channel_routing_policies
  add constraint channel_routing_policies_distribution_mode_check
  check (distribution_mode is null or distribution_mode in ('manual','round_robin','load'));

-- O destino padrão é membro da MESMA organização (FK composta). Se a linha do
-- membro é APAGADA, o vínculo cai (set null). Só que sair da equipe aqui é um
-- UPDATE em `revoked_at` (ou rebaixamento a leitor), não um DELETE: esse caso é
-- tratado pelo gatilho `fn_routing_member_revoked`, no fim desta migration.
alter table public.channel_routing_policies
  drop constraint if exists channel_routing_policies_default_assignee_fkey;
alter table public.channel_routing_policies
  add constraint channel_routing_policies_default_assignee_fkey
  foreign key (organization_id, default_assignee_user_id)
  references public.user_organizations (organization_id, user_id)
  on delete set null (default_assignee_user_id);

-- ─── A RPC ganha dois parâmetros COM DEFAULT ─────────────────────────────────
--
-- A chamada antiga de 4 argumentos continua válida: quem só mexe nos
-- responsáveis (a tela atual e os invariantes de banco) não muda. A assinatura
-- de 4 argumentos é DERRUBADA antes para não sobrar overload ambíguo — o
-- `create or replace` com assinatura diferente cria uma SEGUNDA função ao lado,
-- e a de 4 argumentos passaria a sombrear a nova.
drop function if exists public.fn_set_channel_routing(uuid,uuid,uuid[],boolean);
create or replace function public.fn_set_channel_routing(
  p_org uuid,p_channel uuid,p_users uuid[],p_reset boolean default false,
  p_mode text default null,p_default_assignee uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_policy_id uuid; v_mode text; requested_count integer; found_count integer;
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'manager') or not public.fn_support_write_allowed(p_org)
 then raise exception 'routing_forbidden' using errcode='42501';end if;
 if not public.fn_session_mfa_proven() then raise exception 'routing_mfa_required' using errcode='42501';end if;
 if p_users is null or cardinality(p_users)>1000 or array_position(p_users,null) is not null then
  raise exception 'routing_invalid_members' using errcode='22023';end if;
 if p_mode is not null and p_mode not in('manual','round_robin','load') then
  raise exception 'routing_invalid_mode' using errcode='22023';end if;
 -- Leitores de claim usam SHARE nesta identidade, inclusive na ausência de policy.
 perform 1 from public.channel_sessions where organization_id=p_org and id=p_channel and archived_at is null for update;
 if not found then raise exception 'routing_channel_not_found' using errcode='P0002';end if;
 if p_reset then
  delete from public.channel_routing_policies where organization_id=p_org and channel_session_id=p_channel;
  v_mode:=null;
 else
  select count(distinct x) into requested_count from unnest(p_users) x;
  perform 1 from public.user_organizations where organization_id=p_org and user_id=any(p_users)
   and revoked_at is null and role in('agent','manager','admin') order by user_id for share;
  get diagnostics found_count=row_count;
  if found_count<>requested_count then raise exception 'routing_invalid_members' using errcode='22023';end if;
  -- O destino padrão passa pela MESMA régua dos responsáveis: membro ativo.
  if p_default_assignee is not null then
   perform 1 from public.user_organizations where organization_id=p_org and user_id=p_default_assignee
    and revoked_at is null and role in('agent','manager','admin') for share;
   if not found then raise exception 'routing_invalid_members' using errcode='22023';end if;
  end if;
  insert into public.channel_routing_policies(organization_id,channel_session_id,distribution_mode,default_assignee_user_id)
   values(p_org,p_channel,p_mode,p_default_assignee)
   on conflict(organization_id,channel_session_id) do update set distribution_mode=excluded.distribution_mode,
    default_assignee_user_id=excluded.default_assignee_user_id,updated_at=now() returning id into v_policy_id;
  delete from public.channel_routing_responsibles where organization_id=p_org and channel_routing_responsibles.policy_id=v_policy_id;
  insert into public.channel_routing_responsibles(organization_id,policy_id,user_id)
   select p_org,v_policy_id,x from(select distinct unnest(p_users) x) users;
  v_mode:=p_mode;
 end if;
 perform public.fn_wake_channel_routing(p_org,p_channel);
 return jsonb_build_object('channel_session_id',p_channel,'policy_id',v_policy_id,
  'mode',case when p_reset then 'legacy_unconfigured' when cardinality(p_users)=0 then 'restricted_empty' else 'restricted' end,
  'user_ids',case when p_reset then '[]'::jsonb else to_jsonb(p_users) end,
  'distribution_mode',to_jsonb(v_mode),
  'default_assignee_user_id',to_jsonb(case when p_reset then null else p_default_assignee end));
end;
$$;
revoke all on function public.fn_set_channel_routing(uuid,uuid,uuid[],boolean,text,uuid) from public,anon;
grant execute on function public.fn_set_channel_routing(uuid,uuid,uuid[],boolean,text,uuid) to authenticated;

-- ─── O claim respeita o destino padrão ───────────────────────────────────────
--
-- O destino padrão pode não estar na lista de `channel_routing_responsibles`
-- (são ajustes distintos: responsáveis restringem o rodízio; o destino padrão é
-- uma entrega direta). Sem esta exceção, a entrega ao destino padrão seria
-- recusada com `candidate_not_allowed` e a conversa ficaria na fila para sempre.
create or replace function public.fn_channel_routing_claim(p_org uuid,p_conversation uuid,p_channel uuid,p_user uuid,p_schedule jsonb default null,p_reason text default 'routing')
returns text language plpgsql security definer set search_path=public as $$
declare c public.conversations; pre_contact uuid; member_id uuid; v_policy_id uuid; v_default uuid; availability public.attendant_availability; current_load integer;
begin
 if p_reason not in('routing','handoff') then raise exception 'routing_reason_invalid' using errcode='22023';end if;
 select contact_id into pre_contact from public.conversations where organization_id=p_org and id=p_conversation;
 if not found then return 'conversation_changed';end if;
 perform public.fn_service_lock(p_org,pre_contact);
 perform pg_advisory_xact_lock(hashtextextended(p_org::text||':'||p_user::text,228));
 -- Task9: o trigger de status do canal toca conversas; ordem comum channel -> conversation.
 perform 1 from public.channel_sessions where organization_id=p_org and id=p_channel for share;
 if not found then return 'conversation_changed';end if;
 select * into c from public.conversations where organization_id=p_org and id=p_conversation for no key update;
 if not found or c.contact_id is distinct from pre_contact or c.channel_session_id is distinct from p_channel
  or c.status not in('open','pending','claimed','ai_handling') then return 'conversation_changed';end if;
 if c.assigned_to_user_id is not null then return 'already_assigned';end if;
 select id into member_id from public.user_organizations where organization_id=p_org and user_id=p_user
  and revoked_at is null and role in('agent','manager','admin') for share;
 if not found then return 'candidate_revoked';end if;
 select id,default_assignee_user_id into v_policy_id,v_default from public.channel_routing_policies where organization_id=p_org and channel_session_id=p_channel;
 if found and p_user is distinct from v_default
  and not exists(select 1 from public.channel_routing_responsibles r where r.organization_id=p_org and r.policy_id=v_policy_id and r.user_id=p_user)
 then return 'candidate_not_allowed';end if;
 select * into availability from public.attendant_availability where organization_id=p_org and user_id=p_user for share;
 if not found or not availability.is_available or (p_schedule is not null and availability.schedule is distinct from p_schedule)
 then return 'capacity_changed';end if;
 select count(*) into current_load from public.conversations where organization_id=p_org and assigned_to_user_id=p_user and status in('open','pending','claimed','ai_handling');
 if current_load>=availability.capacity then return 'capacity_changed';end if;
 perform public.fn_conversation_assign(p_org,p_conversation,p_user,p_reason,null,true);
 return 'assigned';
end;
$$;
revoke all on function public.fn_channel_routing_claim(uuid,uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.fn_channel_routing_claim(uuid,uuid,uuid,uuid,jsonb,text) to service_role;

-- ─── Revogar o destino padrão solta o vínculo ────────────────────────────────
--
-- Corpo vigente de `fn_routing_member_revoked` (0228, editada no lugar pela 0405)
-- MAIS o update do destino padrão: quem é removido da equipe (ou rebaixado a
-- leitor) deixa de ser destino de qualquer número. Sem isto, o worker tentaria
-- entregar a quem saiu, receberia `candidate_revoked` e devolveria a conversa à
-- fila; e o próximo Salvar daquele número na tela voltaria 422. O gatilho
-- `trg_routing_member_revoked` (0228) já aponta para esta função.
-- Revogação é UPDATE, não DELETE: cascade sozinho não remove elegibilidade,
-- nem desatribui conversas abertas (#1562).
create or replace function public.fn_routing_member_revoked()
returns trigger language plpgsql security definer set search_path=public as $$
declare
 v_conv record;
begin
 if new.revoked_at is not null or new.role not in('agent','manager','admin') then
  delete from public.channel_routing_responsibles where organization_id=new.organization_id and user_id=new.user_id;
  -- (0663, #2331) Revogação é UPDATE: o ON DELETE SET NULL da FK não dispara aqui.
  update public.channel_routing_policies set default_assignee_user_id=null,updated_at=now()
   where organization_id=new.organization_id and default_assignee_user_id=new.user_id;

  for v_conv in
    select id from public.conversations
     where organization_id=new.organization_id
       and assigned_to_user_id=new.user_id
       and status in('open','pending','claimed','ai_handling')
     order by id
  loop
    update public.conversations
       set assigned_to_user_id=null,
           assigned_to_user_name=null,
           assigned_at=null,
           assignee_kind=null,
           status='open',
           status_changed_at=now(),
           unread_count_for_assignee=0,
           -- Mesma regra do release de fn_conversation_assign: a conversa que a IA
           -- passou a um humano (last_handoff_at) continua com a IA calada.
           bot_silenced_until=case when last_handoff_at is null then null else bot_silenced_until end,
           updated_at=now()
     where id=v_conv.id;

    insert into public.conversation_assignment_events
      (organization_id,conversation_id,from_user_id,to_user_id,changed_by,reason)
    values
      (new.organization_id,v_conv.id,new.user_id,null,auth.uid(),'member_revoked');
  end loop;
 end if;
 perform public.fn_wake_channel_routing(new.organization_id);
 return new;
end;
$$;
revoke all on function public.fn_routing_member_revoked() from public,anon,authenticated;
