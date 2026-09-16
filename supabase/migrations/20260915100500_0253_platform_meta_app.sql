-- ---- App da Meta cadastrado pela tela de admin (Onda 4.3) ----
--
-- Config de PLATAFORMA, não por organização — mesmo molde de
-- `platform_branding`: linha única (`id=1`), RLS ligada com ZERO policies,
-- lida/escrita só via `service_role`. Um App Secret vale para TODAS as WABAs
-- de TODAS as organizações (é o app da plataforma na Meta, não o de um
-- tenant), então a régua multi-tenant de "organization_id em toda tabela" não
-- se aplica aqui — a mesma exceção que `platform_branding` já documenta.
--
-- `app_secret_encrypted` cifra pelas MESMAS RPCs que `channel_sessions.
-- meta_token_encrypted` já usa (`fn_encrypt_oauth`/`fn_decrypt_oauth`, GUC
-- `app.nuvemshop_oauth_key`) — ver `lib/webhooks/secrets.ts`. Não é um
-- terceiro mecanismo de cifra, é o mesmo, aplicado a uma tabela nova.
--
-- `webhook_verify_token` fica em texto puro: diferente do App Secret (que
-- assina cada mensagem recebida), ele só valida o handshake GET que a Meta
-- faz UMA vez ao configurar o endpoint — vazá-lo deixa alguém repetir esse
-- handshake, não forjar mensagem nenhuma (a assinatura HMAC do POST exige o
-- App Secret, que esse valor não revela). Mesmo assim, a LEITURA pela tela de
-- admin nunca devolve o valor cru fora do instante em que é gerado/regerado —
-- ver `lib/channels/meta/platform-app.ts`.
--
-- Fallback: `lib/channels/meta/platform-app.ts` cai no `.env`
-- (`META_APP_SECRET`/`META_WEBHOOK_VERIFY_TOKEN`) campo a campo, quando a
-- tabela está vazia ou aquele campo específico não foi preenchido pela tela —
-- "o arquivo continua valendo até alguém salvar pela tela".
--
-- Idempotente: `create table if not exists` + `drop trigger if exists` antes
-- do `create trigger`. Nenhuma constraint nova sobre dado existente (a tabela
-- nasce vazia).

create table if not exists public.platform_meta_app (
  id                    smallint primary key default 1,
  app_secret_encrypted  bytea,
  webhook_verify_token  text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  updated_by            uuid,
  constraint platform_meta_app_singleton check (id = 1)
);

comment on table public.platform_meta_app is
  'App da Meta (WhatsApp Cloud API) cadastrado pela tela de admin — linha única id=1, config de PLATAFORMA (um App Secret vale para todas as WABAs de todas as organizações). Fallback pro .env (META_APP_SECRET/META_WEBHOOK_VERIFY_TOKEN) campo a campo quando vazia. Lida/escrita só server-side (service_role). Ver lib/channels/meta/platform-app.ts.';

comment on column public.platform_meta_app.app_secret_encrypted is
  'Cifrado por fn_encrypt_oauth — mesmo mecanismo de channel_sessions.meta_token_encrypted. NUNCA sai em log, resposta de API ou erro.';

comment on column public.platform_meta_app.webhook_verify_token is
  'Texto puro (só valida o handshake GET, não assina mensagem). A tela de admin só devolve o valor cru na resposta de criação/regeneração — nunca numa leitura.';

alter table public.platform_meta_app enable row level security;

-- ZERO POLICIES, DE PROPÓSITO — mesmo molde de platform_branding.

revoke all on public.platform_meta_app from anon, authenticated;
grant select, insert, update on public.platform_meta_app to service_role;

drop trigger if exists trg_platform_meta_app_touch on public.platform_meta_app;
create trigger trg_platform_meta_app_touch
  before update on public.platform_meta_app
  for each row execute function public.fn_touch_updated_at();

notify pgrst, 'reload schema';
