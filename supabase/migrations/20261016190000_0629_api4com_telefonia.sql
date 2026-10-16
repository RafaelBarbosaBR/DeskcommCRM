-- manifest: **A api4com entra como provedor do MODO HUMANO de chamada (issue #2697, M1).** `app/api/v1/calls/route.ts` já aceita `mode: "human"` desde a 0348, mas a ponte de áudio pro navegador do atendente nunca foi implementada — hoje um humano em modo `human` disca pelo mesmo trunk Asterisk/PJSIP da IA e não tem como ouvir nem falar. A api4com (voz via REST + webphone WebRTC no navegador, `libwebphone.js`/Kazoo) fecha esse buraco sem tocar no caminho da IA. Duas tabelas novas — `api4com_connections` (uma conta api4com por organização, token cifrado pela MESMA RPC `fn_encrypt_oauth` de Meta/Nuvemshop/WAHA, nunca a senha) e `api4com_extensions` (ramal da api4com por usuário do CRM) — e uma extensão aditiva em `voice_calls` (coluna `provider_call_id` + `'api4com'` no vocabulário de `provider`, mesma receita da 0348 que já tornou `channel_session_id`/`wacalls_call_id` nullable pro provider `'sip'`). Nenhuma linha existente muda de sentido.
-- 0629: schema da integração de telefonia api4com (M1 — fundação, sem webphone ainda).
--
-- ─── Por que DUAS tabelas, e não uma só com tudo ────────────────────────────
--
-- `api4com_connections` é a CONTA (uma por organização — mesmo desenho de
-- `voip_trunk_settings` e `org_voice_calls`: config de UM recurso por org, não
-- lista). `api4com_extensions` é o MAPEAMENTO usuário↔ramal, que é N por
-- organização (um por atendente que liga). Misturar as duas numa tabela só
-- faria a conta virar N linhas por organização sem necessidade, e trocar de
-- conta exigiria apagar/recriar o mapeamento inteiro.
--
-- ─── Por que token, nunca senha ─────────────────────────────────────────────
--
-- O fluxo de conexão (server action, fora desta migration) troca e-mail+senha
-- por um token de acesso que NUNCA expira (`POST /users/accessTokens` com
-- `ttl: -1`, documentado em developers.api4com.com/authentication.html) e
-- descarta a senha na mesma requisição. Só o token é cifrado e gravado — a
-- senha da conta api4com do cliente nunca toca o nosso banco, nem cifrada.
--
-- ─── Por que `sip_password_encrypted` é NULLABLE aqui ───────────────────────
--
-- M1 só precisa do `extension` (texto) pra originar chamada via `POST /calls`
-- (campo `caller`/`extension` da API). A senha SIP do ramal só é necessária
-- pro webphone WebRTC no navegador (M2, registro via WSS) — pedir as duas
-- credenciais na mesma tela antes de precisar da segunda seria fricção sem
-- efeito nenhum até a M2 existir.
--
-- ─── `provider_call_id`, não reaproveitar `wacalls_call_id` ─────────────────
--
-- `wacalls_call_id` é vocabulário do BINÁRIO WaCalls upstream (comentário da
-- própria coluna, 0348) — gravar o id de chamada da api4com lá seria nome
-- errado pra quem lê depois. Coluna nova, aditiva, nullable: toda linha
-- existente (`wacalls`/`sip`) fica com ela em null, do mesmo jeito que já
-- ficam null nas colunas específicas da outra origem.

-- ─── 1. api4com_connections ──────────────────────────────────────────────────

create table if not exists public.api4com_connections (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  domain text not null,
  -- Cifrado por fn_encrypt_oauth (pgp_sym_encrypt/aes256) — a MESMA cifra dos
  -- tokens de Meta/Nuvemshop/WAHA (ver lib/webhooks/secrets.ts). Nunca gravar
  -- em claro: sem a chave mestra o save recusa.
  access_token_encrypted bytea not null,
  -- Só pra exibir "conectado como fulano@empresa.com" na tela — nunca a senha.
  account_email text not null,
  webhook_path_token text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  status text not null default 'connecting'
    check (status in ('connecting', 'healthy', 'token_invalid', 'disconnected', 'error')),
  last_webhook_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint api4com_connections_webhook_path_token_unique unique (webhook_path_token)
);

alter table public.api4com_connections enable row level security;

drop policy if exists api4com_connections_select on public.api4com_connections;
create policy api4com_connections_select on public.api4com_connections
  for select using (organization_id in (select public.fn_user_org_ids()));

-- Escrita só admin: é credencial de conta cobrada por usuário, mesmo nível de
-- sensibilidade de voip_trunk_settings/ai_provider_credentials.
drop policy if exists api4com_connections_admin_write on public.api4com_connections;
create policy api4com_connections_admin_write on public.api4com_connections
  for all
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  );

-- A anon key vai pro browser — sem isto, o GRANT ALL ON TABLES TO anon do
-- baseline deixaria a tabela alcançável sem sessão nenhuma, RLS ou não.
revoke all on public.api4com_connections from anon;

drop trigger if exists trg_api4com_connections_set_updated_at on public.api4com_connections;
create trigger trg_api4com_connections_set_updated_at
  before update on public.api4com_connections
  for each row execute function public.fn_set_updated_at();

-- View segura: NUNCA expõe access_token_encrypted — mesmo padrão de
-- voip_trunk_settings_safe. security_invoker=true: roda com o privilégio de
-- quem CONSULTA, então a RLS da tabela base se aplica através dela também.
create or replace view public.api4com_connections_safe
  with (security_invoker = true) as
select
  organization_id, domain, account_email, webhook_path_token, status,
  last_webhook_at, created_by, created_at, updated_at
from public.api4com_connections;

revoke all on public.api4com_connections_safe from anon;
grant select on public.api4com_connections_safe to authenticated;

-- ─── 2. api4com_extensions ───────────────────────────────────────────────────

create table if not exists public.api4com_extensions (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  extension text not null,
  -- Nullable na M1 (ver cabeçalho) — cifrado pela mesma RPC quando a M2
  -- preencher. Nunca exposto por view nenhuma: só uma rota autenticada,
  -- restrita ao PRÓPRIO usuário, pode pedir a senha decifrada (M2).
  sip_password_encrypted bytea,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

alter table public.api4com_extensions enable row level security;

drop policy if exists api4com_extensions_select on public.api4com_extensions;
create policy api4com_extensions_select on public.api4com_extensions
  for select using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists api4com_extensions_admin_write on public.api4com_extensions;
create policy api4com_extensions_admin_write on public.api4com_extensions
  for all
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  );

revoke all on public.api4com_extensions from anon;

drop trigger if exists trg_api4com_extensions_set_updated_at on public.api4com_extensions;
create trigger trg_api4com_extensions_set_updated_at
  before update on public.api4com_extensions
  for each row execute function public.fn_set_updated_at();

-- sip_password_encrypted nunca sai por PostgREST em claro nem cifrado: nenhuma
-- view a expõe, e a tabela base já está fora do alcance de anon/authenticated
-- direto teria apenas o bytea cifrado mesmo assim.

-- ─── 3. voice_calls: terceiro provider ───────────────────────────────────────

alter table public.voice_calls
  add column if not exists provider_call_id text;

alter table public.voice_calls drop constraint if exists voice_calls_provider_check;
alter table public.voice_calls
  add constraint voice_calls_provider_check
  check (provider = any (array['wacalls', 'sip', 'api4com']));

create unique index if not exists idx_voice_calls_org_provider_call_id
  on public.voice_calls (organization_id, provider, provider_call_id)
  where provider_call_id is not null;

notify pgrst, 'reload schema';
