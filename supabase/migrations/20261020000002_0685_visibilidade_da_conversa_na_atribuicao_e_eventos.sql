-- manifest: **A visibilidade de cada conversa vale também na atribuição e no registro de eventos.** `fn_conversation_assign` passa a responder conversa fora da visibilidade de quem chama como conversa inexistente (zero linhas); as rotas já tratam zero linhas (404 na transferência, 409 ao assumir). A policy `event_log_select` passa a exigir do atendente (agent), para evento ligado a uma conversa (resolvida pelo `entity_id` (`conversation`/`conversation_note`), por `payload.conversation_id`, ou pelo `ref_id` do aviso da Central), que a conversa seja visível a quem lê (`fn_evento_visivel_ao_atendente`, plpgsql definer que chama `fn_can_view_conversation`, molde de `conversation_notes`); uuid que não aponta para conversa da organização fica oculto ao atendente. Viewer, manager, admin e administrador da plataforma seguem lendo a organização inteira por subconsulta sem correlação; workers (service role) inalterados. Parte da definição vigente (0667). Mesmo conteúdo no apêndice do `supabase/baseline.sql`, antes da VARREDURA anon.

CREATE OR REPLACE FUNCTION public.fn_conversation_assign(p_organization_id uuid, p_conversation_id uuid, p_to_user_id uuid, p_reason text, p_expected_assignee uuid DEFAULT NULL::uuid, p_enforce_expected boolean DEFAULT false)
 RETURNS SETOF conversations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_from uuid;
  v_conv public.conversations%rowtype;
begin
  if not public.fn_support_write_allowed(p_organization_id) then raise exception 'support_readonly' using errcode='42501'; end if;
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'agent') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'caller must be an active agent+ member of the organization';
  end if;

  if p_to_user_id is not null then
    if coalesce(public.fn_member_role_in_org(p_to_user_id, p_organization_id), 'none')
         not in ('agent','manager','admin') then
      raise exception 'assignee_not_eligible_member'
        using hint = 'target must be an active agent+ member of the organization';
    end if;
  end if;

  -- Conversa fora da visibilidade de quem chama responde como conversa
  -- inexistente (zero linhas). A regra fica no WHERE, com o dono da própria
  -- linha (reavaliado na versão nova se houver espera), nunca um valor do
  -- corpo. Service role (sem auth.uid) segue.
  select assigned_to_user_id into v_from
    from public.conversations
   where id = p_conversation_id
     and organization_id = p_organization_id
     and (auth.uid() is null or public.fn_can_view_conversation(organization_id, assigned_to_user_id))
   for no key update;

  if not found then
    return;
  end if;

  if p_enforce_expected and v_from is distinct from p_expected_assignee then
    return;
  end if;

  update public.conversations
     set assigned_to_user_id = p_to_user_id,
         -- Desnormalizado JUNTO com o dono, na mesma transação: nunca existe
         -- uma janela em que id e nome discordam. NULL junto com o id quando
         -- a atribuição é removida (release) — nunca sobra um nome órfão de
         -- dono nenhum. Lido de auth.users porque quem chama esta função
         -- (RPC) não necessariamente tem acesso ao Admin API — a definer
         -- resolve por dentro.
         assigned_to_user_name = case
           when p_to_user_id is null then null
           else (select raw_user_meta_data ->> 'full_name' from auth.users where id = p_to_user_id)
         end,
         assigned_at = case when p_to_user_id is null then null else now() end,
         assignee_kind = case when p_to_user_id is null then null else 'user' end,
         status = case when p_to_user_id is null then 'open' else 'claimed' end,
         status_changed_at = now(),
         unread_count_for_assignee = 0,
         bot_silenced_until = case
           when p_reason = 'routing'  then bot_silenced_until
           when p_to_user_id is null  then (case when last_handoff_at is null
                                                 then null
                                                 else bot_silenced_until end)
           else 'infinity'::timestamptz
         end,
         updated_at = now()
   where id = p_conversation_id
   returning * into v_conv;

  insert into public.conversation_assignment_events
    (organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason)
  values
    (p_organization_id, p_conversation_id, v_from, p_to_user_id, auth.uid(), p_reason);

  return next v_conv;
end;
$function$;

revoke all     on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) from public, anon;
grant  execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) to authenticated, service_role;

-- event_log: evento ligado a uma conversa segue a visibilidade da própria
-- conversa (mesmo molde de conversation_notes e ai_reply_drafts), para o
-- atendente (agent). Quem tem visão ampla — viewer, manager, admin e o
-- administrador da plataforma — lê todos os eventos da organização, como antes.
-- Workers usam a service role e não passam por aqui.
--
-- A conversa do evento é resolvida, nesta ordem (coalesce): pelo entity_id
-- quando entity_kind é 'conversation' ou 'conversation_note'; por
-- payload.conversation_id; ou pelo payload.ref_id quando payload.ref_kind =
-- 'conversation' (o aviso da Central, central.aviso_criado). Valor do payload
-- SEM forma de uuid não restringe: o evento segue o pertencimento à
-- organização. Uuid que não aponta para uma conversa da organização fica
-- OCULTO ao atendente (falha fechada). A guarda de regex fica antes do ::uuid
-- porque uma policy que lança erro derruba toda leitura da tabela.
--
-- Custo: a decisão do atendente mora numa função plpgsql (não é embutida pelo
-- planejador) com COST 1. Na expressão da policy, o planejador soma o custo de
-- todos os ramos do OR em toda linha, mesmo quando o primeiro ramo já decide; um
-- exists embutido inflava a estimativa das consultas de gestão até o ponto em
-- que o JIT dispara, e a consulta passava a pagar a compilação. Os dois
-- primeiros ramos são subconsultas SEM correlação (uma avaliação por consulta),
-- e a função só roda para a linha que eles não liberam. Para o atendente, o
-- custo é uma chamada de fn_can_view_conversation por evento ligado a uma
-- conversa que a consulta varre, o mesmo preço por linha da leitura de
-- conversations; as leituras de event_log com sessão no produto exigem
-- manager (operator-metrics, reenvio de automação). A lista de papéis
-- repete a de fn_can_view_conversation: se ela mudar, mude aqui também. Régua
-- para medir: EXPLAIN (ANALYZE) de `select count(*) from public.event_log where
-- organization_id = <org>` com set role authenticated e request.jwt.claims de
-- um manager e de um agent, numa organização com conversas e eventos ligados a
-- elas; confira o custo estimado do plano e a ausência da seção "JIT" no do
-- manager.
--
-- Troca de policy num bloco só: o update.sh reaplica o baseline sem
-- ON_ERROR_STOP, e drop/create soltos poderiam deixar a tabela sem policy de
-- leitura.
create or replace function public.fn_evento_visivel_ao_atendente(
  p_org uuid,
  p_entity_kind text,
  p_entity_id uuid,
  p_payload jsonb
) returns boolean
language plpgsql stable security definer
cost 1
set search_path = public
as $$
declare
  v_conversa uuid;
  v_visivel boolean;
begin
  v_conversa := coalesce(
    case when p_entity_kind in ('conversation', 'conversation_note') then p_entity_id end,
    case when p_payload ->> 'conversation_id'
              ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         then (p_payload ->> 'conversation_id')::uuid end,
    case when p_payload ->> 'ref_kind' = 'conversation'
              and p_payload ->> 'ref_id'
              ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         then (p_payload ->> 'ref_id')::uuid end
  );
  if v_conversa is null then
    return true;
  end if;

  -- Definer: a RLS de conversations não se reaplica aqui; quem decide é
  -- fn_can_view_conversation, com o auth.uid() de quem lê.
  select public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
    into v_visivel
    from public.conversations c
   where c.id = v_conversa
     and c.organization_id = p_org;

  return coalesce(v_visivel, false);
end;
$$;

revoke execute on function public.fn_evento_visivel_ao_atendente(uuid, text, uuid, jsonb) from public, anon;
grant  execute on function public.fn_evento_visivel_ao_atendente(uuid, text, uuid, jsonb) to authenticated, service_role;

do $$
begin
  drop policy if exists "event_log_select" on public.event_log;
  create policy "event_log_select" on public.event_log
    for select using (
      organization_id in (
        select o from public.fn_user_org_ids() o
         where public.fn_user_role_in_org(o) in ('viewer', 'manager', 'admin')
      )
      or (select public.fn_is_platform_admin())
      or (
        organization_id in (select public.fn_user_org_ids())
        and public.fn_evento_visivel_ao_atendente(organization_id, entity_kind, entity_id, payload)
      )
    );
end $$;
