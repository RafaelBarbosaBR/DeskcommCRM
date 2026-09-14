-- ---------------------------------------------------------------------------
-- Formulário unificado de "Novo negócio" — a função/cargo do contato
-- (migration 0240)
--
-- Campo novo pedido pro formulário de criação combinada de contato+lead
-- ("Nome, Sobrenome, E-mail, Telefone, Função, ..."). `job_title` e não
-- `role` de propósito — `role` já significa papel de RBAC (viewer/agent/
-- manager/admin) em outras tabelas deste produto, e reusar a palavra aqui
-- criaria duas perguntas diferentes com o mesmo nome de coluna.
-- ---------------------------------------------------------------------------

alter table public.contacts
  add column if not exists job_title text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'contacts_job_title_len') then
    alter table public.contacts
      add constraint contacts_job_title_len check (job_title is null or length(job_title) <= 150);
  end if;
end $$;
