-- Achado no changelog upstream (Onda 3, item 3.2): o compromisso só podia
-- avisar UMA vez (`calendar_event_types.reminder_minutes_before`, escalar) —
-- uma clínica que quer avisar 24h antes E 1h antes não tinha como configurar
-- as duas. Decisão já tomada com o dono do produto: coluna JSONB, não tabela
-- nova (o par continua pequeno — até 3 lembretes extras por tipo).
--
-- A validação NUMÉRICA de cada entrada (15..10080, o mesmo teto que
-- `reminder_minutes_before` já usa na API) fica na Zod da rota, não aqui —
-- MESMO padrão que aquela coluna já segue (ver o comentário do CHECK dela em
-- `app/api/v1/agenda/tipos/route.ts`): o CHECK do banco é mais LARGO
-- (0..43200, o mesmo de `reminder_minutes_before`) porque a borda estreita é
-- de PRODUTO, não de dado — mudar de opinião sobre "lembrete de 10 min faz
-- sentido?" não pode exigir migration.
alter table public.calendar_event_types
  add column if not exists additional_reminders jsonb not null default '[]'::jsonb;

alter table public.calendar_event_types
  drop constraint if exists calendar_event_types_additional_reminders_shape;
alter table public.calendar_event_types
  add constraint calendar_event_types_additional_reminders_shape check (
    jsonb_typeof(additional_reminders) = 'array'
    and jsonb_array_length(additional_reminders) <= 3
  );

comment on column public.calendar_event_types.additional_reminders is
  'Lembretes ALÉM do escalar reminder_minutes_before — minutos antes do compromisso, até 3 entradas. [] = só o lembrete único (comportamento de sempre). Validação numérica de cada entrada é da API (app/api/v1/agenda/tipos/route.ts), não do banco.';

-- ─── por que o compromisso precisa saber QUAIS já saíram ────────────────────
--
-- `reminder_sent_at` (migration 0177) era um timestamp só: "o lembrete já
-- saiu?", binário. Com N lembretes possíveis por tipo, essa pergunta deixa de
-- fazer sentido sozinha — "já saiu" não diz QUAL dos N. `reminders_sent`
-- guarda os minutos-de-antecedência de cada lembrete JÁ ENVIADO para ESTE
-- compromisso, e o cron (`app/api/v1/cron/agenda-reminder/route.ts`) manda o
-- que falta, nunca reenvia o que já está na lista.
--
-- `reminder_sent_at` CONTINUA existindo e sendo atualizado — passa a guardar
-- o instante do lembrete MAIS RECENTE, útil para quem olha a linha direto no
-- banco. Nenhum código fora deste cron lê a coluna (medido: só
-- app/api/v1/cron/agenda-reminder/route.ts), então manter o nome não quebra
-- consumidor nenhum.
alter table public.calendar_appointments
  add column if not exists reminders_sent jsonb not null default '[]'::jsonb;

alter table public.calendar_appointments
  drop constraint if exists calendar_appointments_reminders_sent_shape;
alter table public.calendar_appointments
  add constraint calendar_appointments_reminders_sent_shape check (
    jsonb_typeof(reminders_sent) = 'array'
  );

comment on column public.calendar_appointments.reminders_sent is
  'Minutos-de-antecedência de cada lembrete já enviado para ESTE compromisso (ver calendar_event_types.additional_reminders). O cron nunca reenvia um valor já presente aqui.';

-- Backfill: quem já tinha `reminder_sent_at` preenchido já recebeu o lembrete
-- PRIMÁRIO (o único que existia antes desta migration) — registra esse
-- offset em `reminders_sent` usando o `reminder_minutes_before` ATUAL do
-- tipo, para o cron não reenviar o mesmo aviso à toa na primeira rodada
-- depois do deploy. Não é perfeito (o tipo pode ter mudado a antecedência
-- desde o envio original), mas erra para o lado seguro: NÃO reenviar.
update public.calendar_appointments a
   set reminders_sent = jsonb_build_array(t.reminder_minutes_before)
  from public.calendar_event_types t
 where a.event_type_id = t.id
   and a.reminder_sent_at is not null
   and a.reminders_sent = '[]'::jsonb;
