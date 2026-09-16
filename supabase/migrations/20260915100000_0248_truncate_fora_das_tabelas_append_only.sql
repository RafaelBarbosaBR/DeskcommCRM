-- Achado no changelog upstream (Onda 2, item 2.1): `api_audit_log`,
-- `crm_lead_activities`, `event_log` e `webhook_events_log` são append-only
-- por doutrina — nada no código legítimo apaga a HISTÓRIA de auditoria,
-- atividade de lead, evento interno ou entrega de webhook. Mesmo assim as
-- quatro concediam TRUNCATE a anon/authenticated/service_role, herdado do
-- `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES` do corpo do baseline —
-- nenhuma delas jamais teve um REVOKE explícito.
--
-- `idempotency_keys` já resolveu exatamente este padrão (migration da issue
-- correspondente, ver `supabase/baseline.sql`): TRUNCATE ignora RLS, e
-- nenhum consumidor legítimo de tabela append-only precisa dele — um só
-- comando, sem WHERE, sem trigger, apaga o histórico inteiro em silêncio.
--
-- `service_role` entra na revogação (diferente do padrão mais antigo, que só
-- tirava de public/anon/authenticated): é a credencial que o `createAdminClient()`
-- do app usa, e é exatamente o código que teria alcance para rodar TRUNCATE
-- por engano — anon/authenticated não tocam estas tabelas de propósito (RLS
-- já as fecha para leitura/escrita direta na maioria dos casos).
revoke truncate on public.api_audit_log from anon, authenticated, service_role;
revoke truncate on public.crm_lead_activities from anon, authenticated, service_role;
revoke truncate on public.event_log from anon, authenticated, service_role;
revoke truncate on public.webhook_events_log from anon, authenticated, service_role;
