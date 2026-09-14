-- ---------------------------------------------------------------------------
-- Rastreamento first-party — eixo de MOTOR DE EVENTOS (migration 0234)
--
-- `internal_events` é o vocabulário agnóstico de 5 eventos (PAGE_VIEW,
-- CONTACT, LEAD, QUALIFIED, PURCHASE) que o resto do CRM conhece — nome de
-- evento de plataforma (Purchase/generate_lead/conversion) nunca aparece
-- fora de `lib/plataformas-de-anuncio/`. `outbound_events` é o ledger
-- cross-provider de despacho (o "log de auditoria" do item 7 do pedido:
-- criado → enviado → aceito/rejeitado). `meta_event_logs` é o detalhe
-- específico de Meta — dedup Pixel×CAPI pelo mesmo event_id (item 4).
--
-- Idempotência de LEAD/QUALIFIED/PURCHASE: um índice único parcial por
-- (organization_id, lead_id, event_type) — cada negócio só gera cada um
-- desses 3 eventos uma vez. PAGE_VIEW/CONTACT não têm lead_id na maioria dos
-- casos (visitante anônimo, ou clique de WhatsApp sem contact_id/lead_id por
-- desenho — item 3) e podem se repetir livremente por sessão.
-- ---------------------------------------------------------------------------

create table if not exists public.internal_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  tracking_site_id uuid references public.tracking_sites(id) on delete set null,
  event_type text not null,
  visitor_id uuid references public.visitors(id) on delete set null,
  session_id uuid references public.sessions(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  lead_id uuid references public.crm_leads(id) on delete set null,
  touchpoint_id uuid references public.touchpoints(id) on delete set null,
  value_cents bigint,
  currency text,
  occurred_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint internal_events_event_type_enum
    check (event_type in ('PAGE_VIEW', 'CONTACT', 'LEAD', 'QUALIFIED', 'PURCHASE')),
  constraint internal_events_currency_iso
    check (currency is null or currency ~ '^[A-Z]{3}$')
);

-- Idempotência: só quando há lead_id e o evento é um dos 3 que marcam
-- progresso de negócio. PAGE_VIEW/CONTACT ficam fora do índice de propósito.
create unique index if not exists internal_events_lead_event_uk
  on public.internal_events (organization_id, lead_id, event_type)
  where lead_id is not null and event_type in ('LEAD', 'QUALIFIED', 'PURCHASE');

create index if not exists internal_events_org_type_idx
  on public.internal_events (organization_id, event_type, occurred_at desc);

create index if not exists internal_events_visitor_idx
  on public.internal_events (visitor_id) where visitor_id is not null;

alter table public.internal_events enable row level security;
revoke all on public.internal_events from anon, authenticated;
grant select, insert, update, delete on public.internal_events to service_role;

create table if not exists public.outbound_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  internal_event_id uuid not null references public.internal_events(id) on delete cascade,
  provider text not null,
  event_name text,
  status text not null default 'pending',
  reason text,
  detail text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  resolved_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint outbound_events_provider_enum
    check (provider in ('META', 'GA4', 'GOOGLE_ADS')),
  constraint outbound_events_status_enum
    check (status in ('pending', 'sent', 'accepted', 'rejected'))
);

create unique index if not exists outbound_events_event_provider_uk
  on public.outbound_events (internal_event_id, provider);

create index if not exists outbound_events_org_status_idx
  on public.outbound_events (organization_id, status, created_at desc);

alter table public.outbound_events enable row level security;
revoke all on public.outbound_events from anon, authenticated;
grant select, insert, update, delete on public.outbound_events to service_role;

drop trigger if exists trg_outbound_events_updated_at on public.outbound_events;
create trigger trg_outbound_events_updated_at
  before update on public.outbound_events
  for each row execute function public.fn_set_updated_at();

-- Detalhe específico de Meta: `pixel_fired` vem de um ping best-effort do
-- browser (tracker.js chama fbq() e avisa o coletor) — ausência não é "não
-- disparou", é "não confirmado" (adblocker no ping também bloqueia o aviso,
-- não só o pixel). `capi_status`/`capi_response` espelham o que já está em
-- `outbound_events` pra provider=META, mas aqui com o corpo cru da resposta
-- da Graph API pra quem for depurar dedup.
create table if not exists public.meta_event_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  internal_event_id uuid not null references public.internal_events(id) on delete cascade,
  event_id text not null,
  pixel_fired boolean not null default false,
  capi_status text,
  capi_response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists meta_event_logs_event_uk
  on public.meta_event_logs (internal_event_id);

alter table public.meta_event_logs enable row level security;
revoke all on public.meta_event_logs from anon, authenticated;
grant select, insert, update, delete on public.meta_event_logs to service_role;

drop trigger if exists trg_meta_event_logs_updated_at on public.meta_event_logs;
create trigger trg_meta_event_logs_updated_at
  before update on public.meta_event_logs
  for each row execute function public.fn_set_updated_at();
