-- ---------------------------------------------------------------------------
-- Compromissos leves por lead (migration 0239)
--
-- NÃO é uma linha em `calendar_appointments` — aquela tabela exige um
-- `event_type_id` pré-configurado e passa pelo motor de disponibilidade
-- (`exigeHorarioLivre`, que recusa horário fora da jornada de trabalho
-- publicada do responsável) e nunca deixa reabrir um cancelado. O pedido
-- aqui é o oposto nos dois pontos: qualquer horário, e cancelado/concluído
-- pode reabrir. Por isso tabela própria, mais simples, sem motor de
-- disponibilidade — mas reaproveitando integralmente `calendar_connections`
-- (conexão por atendente, já cifrada) pra sincronizar com o Google.
--
-- Nome deliberadamente distinto de `calendar_appointments`, pra o schema
-- deixar claro que são dois sistemas.
-- ---------------------------------------------------------------------------

create table if not exists public.crm_lead_appointments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  type text not null,
  title text not null,
  notes text,
  scheduled_at timestamptz not null,
  status text not null default 'pending',
  assigned_to uuid references auth.users(id) on delete set null,
  google_event_id text,
  google_sync_error text,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_lead_appointments_type_enum
    check (type in ('proximo_contato', 'reuniao', 'ligacao', 'outro')),
  constraint crm_lead_appointments_status_enum
    check (status in ('pending', 'completed', 'cancelled')),
  constraint crm_lead_appointments_title_len check (length(title) <= 200),
  constraint crm_lead_appointments_notes_len check (notes is null or length(notes) <= 1000)
);

create index if not exists crm_lead_appointments_lead_idx
  on public.crm_lead_appointments (lead_id, scheduled_at);

-- Serve a visão agregada /app/calendario (cross-lead, filtrada por status e período).
create index if not exists crm_lead_appointments_org_status_idx
  on public.crm_lead_appointments (organization_id, status, scheduled_at);

alter table public.crm_lead_appointments enable row level security;

drop policy if exists "crm_lead_appointments_tenant_isolation_all" on public.crm_lead_appointments;
create policy "crm_lead_appointments_tenant_isolation_all" on public.crm_lead_appointments
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin())
  with check (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());

grant select, insert, update, delete on public.crm_lead_appointments to authenticated;
grant select, insert, update, delete on public.crm_lead_appointments to service_role;

drop trigger if exists trg_crm_lead_appointments_updated_at on public.crm_lead_appointments;
create trigger trg_crm_lead_appointments_updated_at
  before update on public.crm_lead_appointments
  for each row execute function public.fn_set_updated_at();
