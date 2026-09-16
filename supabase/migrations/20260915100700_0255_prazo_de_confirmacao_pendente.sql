-- ---- Pedido pendente expira e devolve o horário (Onda 4.5) ----
--
-- `requires_confirmation` já fazia o compromisso nascer `pending` — só que
-- nada nunca o TIRAVA de lá. Um pedido que ninguém confirmou ficava
-- segurando o horário para sempre, e o cliente que desistiu (ou nunca
-- respondeu) continuava "reservado" nos olhos de `LIBERAM_O_HORARIO`
-- (`lib/agenda/ocupados.ts`), que trata `pending` como ocupação de verdade —
-- de propósito, para dois pedidos não caírem no mesmo instante.
--
-- `pending_expiration_hours` é o prazo, POR TIPO (clínicas e imobiliárias
-- toleram esperas diferentes), configurável pela tela — coluna simples, não
-- tabela nova, mesmo raciocínio de `additional_reminders` (migration 0252).
-- O cron `contact-birthdays`-irmão (`agenda-pending-expirer`) lê esta coluna
-- e CANCELA o que passou do prazo — "quem expira é a RESERVA, não o pedido
-- na fila": o cliente segue podendo pedir de novo, só o horário específico
-- que ele não confirmou volta para o pool.

alter table public.calendar_event_types
  add column if not exists pending_expiration_hours integer not null default 24;

alter table public.calendar_event_types
  drop constraint if exists calendar_event_types_pending_expiration_hours_check;
alter table public.calendar_event_types
  add constraint calendar_event_types_pending_expiration_hours_check check (
    pending_expiration_hours > 0 and pending_expiration_hours <= 720
  );

comment on column public.calendar_event_types.pending_expiration_hours is
  'Horas até um compromisso PENDING (requires_confirmation) expirar e ser cancelado automaticamente pelo cron agenda-pending-expirer. Default 24h. Teto de 720h (30 dias) — acima disso não é "prazo de confirmação", é reserva permanente disfarçada.';

notify pgrst, 'reload schema';
