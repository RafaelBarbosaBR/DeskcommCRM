-- ---------------------------------------------------------------------------
-- Rastreamento first-party — eixo de CONFIGURAÇÃO (migration 0235)
--
-- `integration_settings` guarda a config de cada provider (Meta/GA4/Google
-- Ads) por organização. O formato de credencial é heterogêneo de propósito
-- (Meta = dataset_id+token; GA4 = measurement_id+api_secret; Google Ads =
-- developer_token+client_id/secret+refresh_token+customer_id+mapa de
-- Conversion Action IDs) — em vez de uma coluna por campo (que ficaria cheia
-- de null cruzado entre providers), os segredos de cada provider viram um
-- único blob JSON cifrado (`secrets_encrypted`, via as mesmas RPCs
-- fn_encrypt_oauth/fn_decrypt_oauth que já cifram toda credencial de
-- integração no produto — AES-256 via pgp_sym, chave mestra existente,
-- nenhuma chave nova). O não-secreto (pixel_id, measurement_id, customer_id,
-- mapa de conversion action por evento interno) fica em `config` jsonb, em
-- claro — não é segredo, e ter que decifrar só pra mostrar "conectado" na
-- tela seria trabalho sem motivo.
--
-- `is_qualified` em crm_stages é o gatilho do evento QUALIFIED, no mesmo
-- padrão booleano de is_won/is_lost já existentes — o motor de eventos relê
-- essa coluna a cada mudança de etapa (nunca confia no payload do evento).
-- ---------------------------------------------------------------------------

create table if not exists public.integration_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null,
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  secrets_encrypted bytea,
  test_event_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint integration_settings_provider_enum
    check (provider in ('META', 'GA4', 'GOOGLE_ADS'))
);

create unique index if not exists integration_settings_org_provider_uk
  on public.integration_settings (organization_id, provider);

alter table public.integration_settings enable row level security;
revoke all on public.integration_settings from anon, authenticated;
grant select, insert, update, delete on public.integration_settings to service_role;

drop trigger if exists trg_integration_settings_updated_at on public.integration_settings;
create trigger trg_integration_settings_updated_at
  before update on public.integration_settings
  for each row execute function public.fn_set_updated_at();

alter table public.crm_stages
  add column if not exists is_qualified boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'crm_stages_qualified_wonlost_mutex'
  ) then
    alter table public.crm_stages
      add constraint crm_stages_qualified_wonlost_mutex
      check (not (is_qualified and (is_won or is_lost)));
  end if;
end $$;
