-- ---------------------------------------------------------------------------
-- Rastreamento first-party — eixo de CAPTURA (migration 0233)
--
-- Tracker.js instalável por site do cliente. Este eixo grava só o que a
-- própria página do cliente manda pro endpoint público de coleta — nunca
-- inventa fbclid/gclid/UTM quando ausentes (colunas ficam null). O
-- `site_key` de `tracking_sites` é o token público que o endpoint usa pra
-- resolver organization_id, no mesmo padrão de `webhook_sources.path_token`
-- (fonte confiável do tenant é o path, nunca o corpo da requisição).
--
-- Por que tabela própria e não reaproveitar `webhook_sources`: o volume e o
-- formato são diferentes (um touchpoint por page view, não um lead por
-- envio) e a superfície de ataque é maior (endpoint chamado por qualquer
-- visitante anônimo, não por um sistema configurado por um admin) — misturar
-- os dois faria uma alteração de rate-limit/allowlist de uma feature
-- vazar pra outra sem querer.
-- ---------------------------------------------------------------------------

create table if not exists public.tracking_sites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  site_key text not null default encode(gen_random_bytes(24), 'hex'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists tracking_sites_site_key_uk
  on public.tracking_sites (site_key);

create index if not exists tracking_sites_org_idx
  on public.tracking_sites (organization_id);

alter table public.tracking_sites enable row level security;
revoke all on public.tracking_sites from anon, authenticated;
grant select, insert, update, delete on public.tracking_sites to service_role;

drop trigger if exists trg_tracking_sites_updated_at on public.tracking_sites;
create trigger trg_tracking_sites_updated_at
  before update on public.tracking_sites
  for each row execute function public.fn_set_updated_at();

-- allowlist de Origin pro endpoint público de coleta. Ausência de linhas pra
-- um site = ainda não configurado, o coletor loga e aceita mesmo assim (o
-- primeiro deploy do snippet não pode ficar bloqueado por uma tela que
-- ninguém preencheu ainda) — a checagem é defesa em profundidade, não o
-- mecanismo de autenticação (esse é o site_key no path).
create table if not exists public.tracking_domains (
  id uuid primary key default gen_random_uuid(),
  tracking_site_id uuid not null references public.tracking_sites(id) on delete cascade,
  domain text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists tracking_domains_site_domain_uk
  on public.tracking_domains (tracking_site_id, domain);

alter table public.tracking_domains enable row level security;
revoke all on public.tracking_domains from anon, authenticated;
grant select, insert, update, delete on public.tracking_domains to service_role;

-- Um visitante = um cookie first-party no domínio do site visitado. O valor
-- do cookie é o `visitor_id` (gerado no browser pelo tracker.js), esta
-- tabela só espelha server-side pra permitir join com sessions/touchpoints.
create table if not exists public.visitors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  tracking_site_id uuid not null references public.tracking_sites(id) on delete cascade,
  visitor_id uuid not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists visitors_site_visitor_uk
  on public.visitors (tracking_site_id, visitor_id);

create index if not exists visitors_org_idx
  on public.visitors (organization_id);

alter table public.visitors enable row level security;
revoke all on public.visitors from anon, authenticated;
grant select, insert, update, delete on public.visitors to service_role;

-- Sessão = uma janela de navegação do visitante (o tracker.js decide o corte
-- por inatividade no client). UTM de primeiro touque da sessão fica aqui;
-- UTM/click-id por página fica no touchpoint abaixo (podem variar dentro da
-- mesma sessão se o visitante voltar de outro anúncio).
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  visitor_id uuid not null references public.visitors(id) on delete cascade,
  session_id uuid not null,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  referrer text,
  landing_url text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_term text,
  utm_content text,
  created_at timestamptz not null default now()
);

create unique index if not exists sessions_session_id_uk
  on public.sessions (session_id);

create index if not exists sessions_visitor_idx
  on public.sessions (visitor_id);

alter table public.sessions enable row level security;
revoke all on public.sessions from anon, authenticated;
grant select, insert, update, delete on public.sessions to service_role;

-- Um touchpoint por interação capturada (page view, clique de WhatsApp,
-- envio de formulário). fbclid/fbc/gclid/gbraid/wbraid ficam null quando o
-- parâmetro não veio na URL — nunca fabricados (item 1 do pedido). `fbc` é o
-- valor já calculado pelo tracker.js seguindo a spec oficial da Meta
-- (fb.1.<timestamp_ms>.<fbclid>), gravado aqui como prova, não recalculado
-- no servidor.
create table if not exists public.touchpoints (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  visitor_id uuid not null references public.visitors(id) on delete cascade,
  session_id uuid references public.sessions(id) on delete set null,
  occurred_at timestamptz not null default now(),
  url text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_term text,
  utm_content text,
  fbclid text,
  fbc text,
  gclid text,
  gbraid text,
  wbraid text,
  contact_id uuid references public.contacts(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists touchpoints_visitor_idx
  on public.touchpoints (visitor_id, occurred_at desc);

create index if not exists touchpoints_contact_idx
  on public.touchpoints (contact_id) where contact_id is not null;

alter table public.touchpoints enable row level security;
revoke all on public.touchpoints from anon, authenticated;
grant select, insert, update, delete on public.touchpoints to service_role;

-- O elo entre o mundo de rastreamento e o CRM: um contato "nasceu"
-- (ou foi identificado) numa sessão rastreada pelo tracker.js. É a condição
-- de entrada do motor de eventos novo (migration 0234) — nunca sobrescrita
-- (first-touch, feito em app code no momento da identificação, não aqui).
alter table public.contacts
  add column if not exists visitor_id uuid references public.visitors(id) on delete set null;

create index if not exists contacts_visitor_idx
  on public.contacts (visitor_id) where visitor_id is not null;
