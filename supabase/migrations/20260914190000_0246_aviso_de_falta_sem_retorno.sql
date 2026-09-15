-- 0246_aviso_de_falta_sem_retorno
--
-- A régua de recuperação de falta (0224) já cobre o caso "a recuperação NEM
-- COMEÇOU" (`appointment_recovery_review`, criado por `fn_appointment_recover`
-- quando `not_configured`/`ambiguous`/etc). O que faltava é o caso diferente:
-- a recuperação COMEÇOU, rodou a régua inteira, e o cliente nunca respondeu.
-- Hoje isso termina em silêncio — `followup_enrollments.status='completed',
-- outcome='exhausted'` (a régua tem um nó "Fim" configurado com esse
-- desfecho), e nada olha para essa transição. O card fica parado na mesma
-- etapa e ninguém é avisado de que a recuperação esgotou.
--
-- ═══ ONDE ENTRA, E POR QUÊ AQUI ═══
--
-- `fn_followup_patch` é o ÚNICO caminho por onde uma matrícula muda de
-- status — `lib/followup/engine.ts` (`db.updateEnrollment`) chama só esta
-- RPC, nunca um UPDATE direto. Interceptar a transição aqui, e não em TS
-- depois do RPC responder, fecha a mesma classe de janela que o resto do
-- schema já evita: se o processo do worker cair entre o UPDATE e um efeito
-- em TS, o efeito nunca aconteceria; dentro da mesma transação SQL, os dois
-- ou acontecem juntos ou nenhum acontece.
--
-- ═══ SÓ QUANDO O ENROLLMENT É DE UM COMPROMISSO ═══
--
-- `outcome='exhausted'` pode vir de QUALQUER fluxo de follow-up — uma régua
-- de reengajamento de marketing esgotando não é "falta sem retorno", e criar
-- aviso ali seria ruído. O corte é `current.appointment_id is not null`: só
-- matrículas que nasceram de `fn_appointment_recover` (0224) têm esse campo
-- preenchido.
--
-- ═══ DEDUP: O MESMO PADRÃO JÁ PROVADO NA 0224 ═══
--
-- `inbox_appointment_revision_unique` (0224) já existe e já cobre
-- `(organization_id, ref_id, appointment_revision, kind)` — não precisa de
-- índice novo. "Reprocessar não duplica" e "o mesmo compromisso remarcado
-- gera aviso novo" saem de graça: `appointment_revision` muda a cada
-- remarcação, e o índice é por revisão, não só por compromisso.

-- ── 1. novo kind, bloco único (doutrina: uma constraint, um bloco) ──────────
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
    -- (migration 0246) A régua de recuperação de falta rodou até o fim e o
    -- cliente nunca respondeu. Ver o cabeçalho desta migration.
    'appointment_recovery_exhausted',
    'other'
  ));

-- ── 2. fn_followup_patch ganha o aviso, corpo INTEIRO reemitido ────────────
create or replace function public.fn_followup_patch(p_org uuid,p_id uuid,p_revision bigint,p_patch jsonb)
returns bigint language plpgsql security definer set search_path=public as $$
declare current public.followup_enrollments; patched public.followup_enrollments; contact uuid;
begin
 select contact_id into contact from public.followup_enrollments where id=p_id and organization_id=p_org;
 if not found then raise exception 'followup_stale' using errcode='40001'; end if;
 perform public.fn_service_lock(p_org,contact);
 select * into current from public.followup_enrollments where id=p_id and organization_id=p_org for update;
 if current.contact_id is distinct from contact or current.revision is distinct from p_revision then raise exception 'followup_stale' using errcode='40001'; end if;
 if p_patch->>'status' in ('active','waiting_reply') and current.appointment_revision is not null and not public.fn_appointment_enrollment_current(p_org,p_id,current.current_node_id) then raise exception 'followup_stale' using errcode='40001'; end if;
 select * into patched from jsonb_populate_record(current,p_patch);
 update public.followup_enrollments set status=patched.status,current_node_id=patched.current_node_id,next_eval_at=patched.next_eval_at,
  claimed_until=patched.claimed_until,attempts=patched.attempts,last_error=patched.last_error,steps_taken=patched.steps_taken,
  outcome=patched.outcome,cancel_reason=patched.cancel_reason,completed_at=patched.completed_at,timing_plan=patched.timing_plan
 where organization_id=p_org and id=p_id returning revision into p_revision;

 -- (0246) Régua de recuperação de falta esgotada sem resposta — ver o
 -- cabeçalho desta migration para o raciocínio completo.
 if patched.status='completed' and patched.outcome='exhausted' and current.appointment_id is not null then
   insert into public.agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id,appointment_revision)
   select p_org,'appointment_recovery_exhausted','warn',
     'Cliente faltou e não respondeu à recuperação',
     'A régua de recuperação foi enviada até o fim e o cliente não respondeu. Decida o próximo passo e mova o card no funil.',
     'appointment',current.appointment_id,current.appointment_revision
   on conflict(organization_id,ref_id,appointment_revision,kind) where ref_kind='appointment' and appointment_revision is not null
   do nothing;
 end if;

 return p_revision;
end; $$;
revoke all on function public.fn_followup_patch(uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.fn_followup_patch(uuid,uuid,bigint,jsonb) to service_role;

notify pgrst, 'reload schema';
