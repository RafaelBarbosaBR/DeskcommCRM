-- ---------------------------------------------------------------------------
-- Dossiê do lead — bloco UTM EDITÁVEL (origem comercial/override) + código
-- de país padrão pro gerador de link do WhatsApp (migration 0237)
--
-- Estas 6 colunas são o bloco que o ATENDENTE preenche à mão (indicação,
-- tracking que não capturou nada) — nunca são tocadas pelo motor de
-- rastreamento automático (que lê `touchpoints`, tabela separada, só
-- leitura no dossiê). Os dois blocos nunca se sobrescrevem porque vivem em
-- lugares diferentes: um é coluna do lead, o outro é projeção de uma tabela
-- de terceiros.
-- ---------------------------------------------------------------------------

alter table public.crm_leads
  add column if not exists utm_source text,
  add column if not exists utm_medium text,
  add column if not exists utm_campaign text,
  add column if not exists utm_content text,
  add column if not exists utm_term text,
  add column if not exists referrer text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crm_leads_utm_source_len') then
    alter table public.crm_leads add constraint crm_leads_utm_source_len check (utm_source is null or length(utm_source) <= 255);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crm_leads_utm_medium_len') then
    alter table public.crm_leads add constraint crm_leads_utm_medium_len check (utm_medium is null or length(utm_medium) <= 255);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crm_leads_utm_campaign_len') then
    alter table public.crm_leads add constraint crm_leads_utm_campaign_len check (utm_campaign is null or length(utm_campaign) <= 255);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crm_leads_utm_content_len') then
    alter table public.crm_leads add constraint crm_leads_utm_content_len check (utm_content is null or length(utm_content) <= 255);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crm_leads_utm_term_len') then
    alter table public.crm_leads add constraint crm_leads_utm_term_len check (utm_term is null or length(utm_term) <= 255);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crm_leads_referrer_len') then
    alter table public.crm_leads add constraint crm_leads_referrer_len check (referrer is null or length(referrer) <= 255);
  end if;
end $$;

-- Heurística de código de país do gerador de link do WhatsApp: configurável
-- por conta (item 3 do pedido — "nunca fixa pra qualquer conta"), nunca
-- hardcoded em código. `lib/channels/phone-variants.ts` (dedupe de contato)
-- fica intocado — é uma heurística diferente, pra um problema diferente.
alter table public.organizations
  add column if not exists whatsapp_default_country_code text not null default '55';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_whatsapp_country_code_format') then
    alter table public.organizations
      add constraint organizations_whatsapp_country_code_format
      check (whatsapp_default_country_code ~ '^[0-9]{1,3}$');
  end if;
end $$;
