-- ---------------------------------------------------------------------------
-- Dossiê do lead — redes sociais/links + telefone como foi digitado
-- (migration 0236)
--
-- `_normalized` é só pra comparação/dedupe — nunca vira link clicável (a
-- normalização remove protocolo, então usá-la como href quebraria o link).
-- O href de verdade é montado em app code a partir da coluna crua, sempre com
-- protocolo garantido antes de virar `<a href>` ou de gravar no banco.
--
-- `phone_raw` é O QUE A PESSOA DIGITOU no dossiê, preservado tal qual —
-- `contacts.phone_number` continua sendo a forma canônica E.164 (Brasil),
-- intocada: é dela que o dedupe de contato/canal já depende
-- (lib/channels/contato-por-telefone.ts). Duas colunas, papéis diferentes,
-- nenhuma sobrescreve a outra.
-- ---------------------------------------------------------------------------

alter table public.contacts
  add column if not exists website_url text,
  add column if not exists website_url_normalized text,
  add column if not exists instagram_url text,
  add column if not exists instagram_url_normalized text,
  add column if not exists facebook_url text,
  add column if not exists facebook_url_normalized text,
  add column if not exists google_maps_url text,
  add column if not exists google_maps_url_normalized text,
  add column if not exists phone_raw text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'contacts_website_url_len') then
    alter table public.contacts
      add constraint contacts_website_url_len check (website_url is null or length(website_url) <= 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'contacts_instagram_url_len') then
    alter table public.contacts
      add constraint contacts_instagram_url_len check (instagram_url is null or length(instagram_url) <= 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'contacts_facebook_url_len') then
    alter table public.contacts
      add constraint contacts_facebook_url_len check (facebook_url is null or length(facebook_url) <= 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'contacts_google_maps_url_len') then
    alter table public.contacts
      add constraint contacts_google_maps_url_len check (google_maps_url is null or length(google_maps_url) <= 1000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'contacts_phone_raw_len') then
    alter table public.contacts
      add constraint contacts_phone_raw_len check (phone_raw is null or length(phone_raw) <= 30);
  end if;
end $$;
