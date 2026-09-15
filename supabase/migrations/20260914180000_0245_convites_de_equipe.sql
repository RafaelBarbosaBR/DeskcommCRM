-- 0245_convites_de_equipe
--
-- `team_invites` — a metade que faltava do convite HMAC stateless
-- (`lib/auth/invite-token.ts`): o TOKEN nunca precisou de linha no banco pra
-- ser verificado (a assinatura já prova tudo), mas sem linha nenhuma não
-- havia onde ver "os convites que este admin mandou" nem como REVOGAR um
-- link que já saiu — só dava pra "não reenviar" (pular quem já é membro), e
-- nada impedia o link de continuar valendo até o TTL de 24h esgotar sozinho.
--
-- `id` da linha é o MESMO `invite_id` que entra no payload assinado do
-- token — não um uuid novo. É o que permite `aplicarConvite` (lib/auth/
-- aplicar-convite.ts) achar a linha certa sem precisar decodificar o token
-- de novo, e é o que faz `issueInvite`/`sendOnboardingInvites` gravarem a
-- MESMA identidade que já geraram.
--
-- Vocabulário aberto (DIRC) em nenhum campo aqui: `role` já é fechado no
-- token (`invite-token.ts`), `status` é o próprio ciclo de vida desta
-- tabela, então os dois levam CHECK.

create table if not exists public.team_invites (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  role text not null check (role in ('viewer', 'agent', 'manager', 'admin')),
  interface_settings jsonb not null default '{"preset":"completa"}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'expired', 'revoked')),
  invited_by uuid references auth.users(id) on delete set null,
  invited_at timestamptz not null default now(),
  -- Expiração do token MAIS RECENTE emitido para este invite_id — reenviar
  -- avança este campo; não é a data de criação da linha (`invited_at`, que
  -- nunca muda). `iat` do token reconstruído em "copiar link"
  -- (`expires_at - INVITE_TTL_SECONDS`) deriva dele, por isso os dois têm de
  -- andar juntos (ver `lib/auth/resend-invite.ts`).
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  resent_count integer not null default 0,
  last_resent_at timestamptz,
  -- Instalação sem serviço de e-mail configurado (RESEND_API_KEY ausente):
  -- o link continua existindo e a tela oferece "copiar link" — sem este
  -- campo não haveria como a lista distinguir "mandei e não sei se chegou"
  -- de "nem tentei mandar".
  email_dispatched boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_team_invites_org on public.team_invites(organization_id);
create index if not exists idx_team_invites_org_status on public.team_invites(organization_id, status);

alter table public.team_invites enable row level security;

drop policy if exists team_invites_select on public.team_invites;
drop policy if exists team_invites_write on public.team_invites;

-- Leitura: `manager`+ (mesmo corte da aba Atendimento — ver TeamPage). Quem
-- não administra convite nenhum não precisa ver quem foi convidado.
create policy team_invites_select on public.team_invites for select
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  );

-- Escrita: só `admin` — mesmo papel que já emite convite hoje
-- (`requireRole("admin")` em app/api/v1/team/invite/route.ts).
create policy team_invites_write on public.team_invites for all
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  );

-- A anon key vai para o browser — sem isto o `GRANT ALL ON TABLES TO anon`
-- do baseline deixaria a lista de convites (e-mails de gente) alcançável
-- sem sessão nenhuma.
revoke all on public.team_invites from anon;

drop trigger if exists trg_team_invites_set_updated_at on public.team_invites;
create trigger trg_team_invites_set_updated_at
  before update on public.team_invites
  for each row execute function public.fn_set_updated_at();

notify pgrst, 'reload schema';
