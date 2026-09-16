-- Onda 4.6 — job `inbound_turn` morto ganha kind próprio; `event_dead` deixa
-- de ser órfão; e o guard "no máximo um aberto por (organização, kind)" passa
-- a valer para os três: `job_dead`, `inbound_turn_dead`, `event_dead`.
--
-- ═══ POR QUE inbound_turn PRECISAVA DE KIND PRÓPRIO ═══
--
-- `failJob`/`reapExpiredJobs` (lib/agent-engine/queue/queue.ts) abriam
-- SEMPRE `job_dead`, "Job descartado após esgotar tentativas" — verdade
-- técnica, mas o `inbound_turn` é a resposta a UM CLIENTE que escreveu. Quem
-- lê a Central não sabia distinguir "uma tarefa de manutenção falhou" de "a
-- IA parou de responder um atendimento em andamento" — e são urgências
-- diferentes. O `kind` novo entra AQUI no CHECK; a lógica que escolhe entre
-- os dois kinds e o título vive no TypeScript (queue.ts), não em SQL —
-- `failJob`/`reapExpiredJobs` são funções puras de aplicação, sem função de
-- banco equivalente.
--
-- ═══ POR QUE event_dead ERA ÓRFÃO ═══
--
-- `lib/event-log/drain.ts` marca `status='dead'` quando um evento esgota
-- `MAX_ATTEMPTS`, e nunca abria aviso — o INSERT em `agent_inbox_items`
-- nasce agora no próprio drain (TypeScript, mesmo padrão de
-- `avisarMidiaNaoLida`), não precisa de mudança de schema. Os 3 event_type
-- contáveis da Onda 2.6 (`crm.activity_write_failed`,
-- `whatsapp.chat_id_not_recognized`, `whatsapp.conversation_mark_failed`)
-- nascem `done` e nunca alcançam este `dead` — todo `event_dead` agora aberto
-- é, por construção, acionável.
--
-- ═══ O GUARD "MÁX. 1 ABERTO POR (ORG, KIND)" ═══
--
-- `failJob`/`reapExpiredJobs` ganham `not exists` na própria query (TS). A
-- ÚNICA rota de `job_dead` em SQL — `fn_followup_inline_settle`, abaixo — não
-- tinha guard nenhum; sem ele, um canal fora do ar por horas abriria um
-- `job_dead` crítico POR ENVIO de follow-up perdido. Reconstruída aqui com o
-- mesmo `where not exists`.
--
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
    'inbound_turn_dead',
    'other'
  ));

drop function if exists public.fn_followup_inline_settle(uuid,uuid,text,boolean,text,timestamptz,boolean,timestamptz);
create or replace function public.fn_followup_inline_settle(p_org uuid,p_id uuid,p_worker text,p_done boolean,p_error text default null,p_retry_at timestamptz default null,p_hold boolean default false,p_acquired_at timestamptz default null)
returns boolean language plpgsql security definer set search_path=public as $$
declare j public.job_queue;
begin
 update public.job_queue set
  status=case when p_done then 'done' when p_hold then 'pending' when attempts>=max_attempts then 'dead' else 'pending' end,
  attempts=case when p_hold then greatest(0,attempts-1) else attempts end,
  run_after=coalesce(p_retry_at,now()+interval '1 minute'),locked_by=null,locked_at=null,last_error=left(p_error,400)
 where organization_id=p_org and id=p_id and kind='followup_turn' and status='running' and locked_by=p_worker and locked_at=p_acquired_at returning * into j;
 if not found then return false; end if;
 if j.status='dead' then
  -- Onda 4.6: mesmo guard de `failJob`/`reapExpiredJobs` — no máximo um
  -- `job_dead` aberto por organização, independente de qual dos três
  -- caminhos o abriu.
  insert into public.agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id)
   select p_org,'job_dead','critical','O acompanhamento não conseguiu enviar a mensagem',
    'Abra o acompanhamento e confira o canal. Motivo: '||coalesce(j.last_error,'envio indisponível'),'job_queue',j.id
   where not exists (
     select 1 from public.agent_inbox_items
      where organization_id=p_org and kind='job_dead' and status='open'
   );
 end if;
 return true;
end; $$;
revoke all on function public.fn_followup_inline_settle(uuid,uuid,text,boolean,text,timestamptz,boolean,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_followup_inline_settle(uuid,uuid,text,boolean,text,timestamptz,boolean,timestamptz) to service_role;

notify pgrst, 'reload schema';
