-- Achado no changelog upstream (Onda 2, item 2.6): três `event_type` —
-- `crm.activity_write_failed` (lib/leads/activity-write-failure.ts),
-- `whatsapp.chat_id_not_recognized` e `whatsapp.conversation_mark_failed`
-- (lib/waha/ingest.ts) — são emitidos com a intenção declarada no próprio
-- comentário do código de ser só CONTÁVEIS: `select count(*) from event_log
-- where event_type = '...'` responde "estamos perdendo alguma coisa?", sem
-- nenhum consumidor pra processar. Mas `emit_event` grava toda linha com
-- `status='pending'` (o default da tabela), e o drain (`lib/event-log/drain.ts`)
-- só olha `status='pending'` — sem consumidor que os marque `done`, os três
-- tipos ficam presos em `pending` para sempre, reprocessados a cada corrida do
-- drain sem nunca sair dali. Puro acúmulo, sem propósito.
--
-- O gatilho é o único lugar que enxerga TODO caminho de inserção — atual e
-- futuro — sem depender de cada produtor lembrar de marcar `done` sozinho.
create or replace function public.fn_event_log_contaveis_nascem_done()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.event_type in (
    'crm.activity_write_failed',
    'whatsapp.chat_id_not_recognized',
    'whatsapp.conversation_mark_failed'
  ) then
    new.status := 'done';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_event_log_contaveis_nascem_done on public.event_log;
create trigger trg_event_log_contaveis_nascem_done
  before insert on public.event_log
  for each row
  execute function public.fn_event_log_contaveis_nascem_done();

-- Expurgo do acúmulo já pendente: os três tipos NÃO são apagados (continuam
-- servindo o COUNT(*) que o código já documenta) — só param de circular pelo
-- drain como se fossem processáveis.
update public.event_log
   set status = 'done'
 where event_type in (
   'crm.activity_write_failed',
   'whatsapp.chat_id_not_recognized',
   'whatsapp.conversation_mark_failed'
 )
   and status in ('pending', 'processing');
