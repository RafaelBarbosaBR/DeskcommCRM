-- ---------------------------------------------------------------------------
-- Listas salvas — um filtro de tag salvo, que vira atalho no menu lateral
-- (migration 0238)
--
-- Não é entrada de `NAV_CATALOG` (esse catálogo é estático, definido em
-- build-time) — é dado por organização, renderizado numa seção própria do
-- Sidebar. `pipeline_id` é opcional: uma lista pode valer pra um funil
-- específico (`?tag=x` naquele quadro) ou, se nulo, é resolvida contra o
-- funil padrão da organização no momento de montar o link.
-- ---------------------------------------------------------------------------

create table if not exists public.crm_saved_lead_views (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  pipeline_id uuid references public.crm_pipelines(id) on delete cascade,
  label text not null,
  tag text not null,
  position numeric not null default 1000,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  constraint crm_saved_lead_views_label_len check (length(label) <= 60),
  constraint crm_saved_lead_views_tag_len check (length(tag) <= 50)
);

create index if not exists crm_saved_lead_views_org_idx
  on public.crm_saved_lead_views (organization_id, position);

alter table public.crm_saved_lead_views enable row level security;

drop policy if exists "crm_saved_lead_views_tenant_isolation_all" on public.crm_saved_lead_views;
create policy "crm_saved_lead_views_tenant_isolation_all" on public.crm_saved_lead_views
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin())
  with check (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());

grant select, insert, update, delete on public.crm_saved_lead_views to authenticated;
grant select, insert, update, delete on public.crm_saved_lead_views to service_role;
