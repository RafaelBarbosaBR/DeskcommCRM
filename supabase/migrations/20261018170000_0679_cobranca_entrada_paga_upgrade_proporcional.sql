-- manifest: **Entrada paga e upgrades proporcionais na cobrança do revendedor.**
-- O cadastro público pode escolher um plano oferecido; planos sem trial bloqueiam
-- a organização até a primeira confirmação de pagamento. Upgrade em período pago
-- guarda o ajuste pendente, preserva o vencimento e só aplica o plano após pagar.
-- Revendedor sem plano nenhum (nem padrão, nem oferecido): a empresa segue
-- nascendo isenta, como antes (doc 146, opção B).

alter table public.cobranca_assinaturas
  add column if not exists pagamento_inicial_pendente boolean not null default false,
  add column if not exists periodo_pago_desde timestamptz,
  add column if not exists plano_troca_pendente_id uuid references public.cobranca_planos(id) on delete restrict,
  add column if not exists troca_id uuid,
  add column if not exists troca_valor_cents integer,
  add column if not exists troca_status text,
  add column if not exists troca_pagamento_ref text,
  add column if not exists troca_pagamento_url text,
  add column if not exists troca_reserva_ate timestamptz;

-- Num bloco só: o update.sh reaplica sem ON_ERROR_STOP e em autocommit, e um
-- add que falhasse depois do drop solto deixaria a coluna sem guarda.
do $troca_status$
begin
  alter table public.cobranca_assinaturas
    drop constraint if exists cobranca_assinaturas_troca_status_check;
  alter table public.cobranca_assinaturas
    add constraint cobranca_assinaturas_troca_status_check
    check (troca_status is null or troca_status in ('criando', 'aguardando_pagamento', 'pago'));
end
$troca_status$;

-- Cadastro self-service: o plano escolhido atravessa `organizations.settings`
-- apenas durante o INSERT. O gatilho valida que continua público e remove o
-- campo transitório na mesma transação. Sem escolha explícita, usa o padrão.
create or replace function public.fn_trial_na_criacao_da_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plano_id uuid;
  v_trial_dias integer;
  v_escolheu_plano boolean := nullif(new.settings->>'cobranca_signup_plan_id', '') is not null;
begin
  if new.created_by is null or not public.fn_cobranca_ligada() then
    return null;
  end if;
  if exists (select 1 from public.platform_admins pa
              where pa.user_id = new.created_by and pa.revoked_at is null) then
    return null;
  end if;

  -- O campo é transitório: sai já, em todo caminho que segue (inclusive o isento).
  update public.organizations
     set settings = coalesce(settings, '{}'::jsonb) - 'cobranca_signup_plan_id'
   where id = new.id and settings ? 'cobranca_signup_plan_id';

  -- Escolha que não vale mais (o plano deixou de ser oferecido ou foi arquivado
  -- entre o cadastro e a confirmação do e-mail; ou metadata adulterada) vale
  -- como "sem escolha": cai no padrão. Recusar travava a empresa para sempre —
  -- a recuperação em /get-started reenvia a MESMA metadata.
  if v_escolheu_plano then
    begin
      v_plano_id := (new.settings->>'cobranca_signup_plan_id')::uuid;
    exception when invalid_text_representation then
      v_plano_id := null;
    end;
    select p.trial_dias into v_trial_dias
      from public.cobranca_planos p
     where p.id = v_plano_id and p.arquivado_em is null and p.oferecido_ao_cliente;
    if not found then
      v_escolheu_plano := false;
    end if;
  end if;
  if not v_escolheu_plano then
    select p.id, p.trial_dias into v_plano_id, v_trial_dias
      from public.cobranca_planos p
     where p.padrao_no_cadastro and p.arquivado_em is null;
    if v_plano_id is null then
      -- Decisão do dono (doc 146, opção B, 15/10): o revendedor que não tem
      -- plano NENHUM (nem padrão, nem oferecido) segue como antes da 0679 e a
      -- empresa nasce isenta. Com plano oferecido e sem padrão, não: o cadastro
      -- sem escolha pularia a entrada paga. Espelho em lib/cobranca/cadastro.ts.
      if not exists (select 1 from public.cobranca_planos p
                      where p.arquivado_em is null and p.oferecido_ao_cliente) then
        return null;
      end if;
      raise exception 'plano_obrigatorio' using errcode = '22023';
    end if;
  end if;

  insert into public.cobranca_assinaturas
    (organization_id, plano_id, estado, trial_ate, pagamento_inicial_pendente)
  values
    (new.id, v_plano_id,
     'trial',
     now() + make_interval(days => v_trial_dias),
     v_trial_dias = 0)
  on conflict (organization_id) do nothing;

  if v_trial_dias = 0 then
    perform public.fn_suspender_organizacao(new.id, 'cobranca', 'Aguardando o primeiro pagamento', null);
  end if;
  return null;
end;
$$;

revoke execute on function public.fn_trial_na_criacao_da_org() from public, anon, authenticated;

-- A criação pelo painel do dono tem o mesmo bloqueio de entrada sem trial.
-- Corpo vigente da migration 0583, com o estado pendente e a suspensão na mesma
-- transação da organização, vínculo e assinatura.
create or replace function public.fn_create_tenant_with_owner(
  p_actor uuid, p_key uuid, p_request jsonb, p_hash text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  prior public.idempotency_keys%rowtype;
  org public.organizations%rowtype;
  result jsonb;
  dono_e_outra_pessoa boolean;
  v_plano_id uuid;
  v_trial_dias integer;
begin
  if not exists (select 1 from public.platform_admins where user_id = p_actor
    and revoked_at is null and scope = 'full') then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text || ':' || p_key::text, 0));
  select * into prior from public.idempotency_keys
    where key = p_key::text and endpoint = '/api/v1/admin/tenants:' || p_actor::text
      and expires_at > now() and tenant_creation_trusted;
  if found then
    if prior.request_hash <> decode(p_hash, 'hex') then
      raise exception 'idempotency_conflict' using errcode = '22023';
    end if;
    if prior.response_body->>'id' is distinct from prior.organization_id::text
      or not exists (select 1 from public.organizations where id = prior.organization_id and created_by = p_actor) then
      raise exception 'idempotency_provenance_invalid' using errcode = '22023';
    end if;
    return prior.response_body || jsonb_build_object('created', false);
  end if;

  v_plano_id := nullif(p_request->>'plano_id', '')::uuid;
  if v_plano_id is not null then
    if not public.fn_cobranca_ligada() then
      raise exception 'cobranca_desligada' using errcode = '22023';
    end if;
    select p.trial_dias into v_trial_dias
      from public.cobranca_planos p
     where p.id = v_plano_id and p.arquivado_em is null;
    if not found then
      raise exception 'plano_invalido' using errcode = '22023';
    end if;
  end if;

  dono_e_outra_pessoa := lower(p_request->>'owner_email') is distinct from
    (select lower(email) from auth.users where id = p_actor);

  insert into public.organizations(display_name, slug, legal_name, cnpj, status, settings, created_by)
    values (p_request->>'display_name', p_request->>'slug', coalesce(nullif(p_request->>'legal_name', ''), p_request->>'display_name'),
      p_request->>'cnpj', 'active',
      case when p_request ? 'plan' then jsonb_build_object('plan', p_request->>'plan') else '{}'::jsonb end,
      p_actor)
    returning * into org;
  insert into public.user_organizations(organization_id, user_id, role, accepted_at, interface_settings, provisional_until_handover)
    values (org.id, p_actor, 'admin', now(),
      case when dono_e_outra_pessoa
        then '{"preset":"completa"}'::jsonb
        else coalesce(p_request->'owner_interface_settings', '{"preset":"completa"}'::jsonb) end,
      dono_e_outra_pessoa);

  if v_plano_id is not null then
    insert into public.cobranca_assinaturas
      (organization_id, plano_id, estado, trial_ate, pagamento_inicial_pendente)
    values (org.id, v_plano_id,
      'trial',
      now() + make_interval(days => v_trial_dias), v_trial_dias = 0);
    if v_trial_dias = 0 then
      perform public.fn_suspender_organizacao(org.id, 'cobranca', 'Aguardando o primeiro pagamento', null);
    end if;
  end if;

  result := jsonb_build_object('id', org.id, 'slug', org.slug, 'display_name', org.display_name,
    'invite_id', gen_random_uuid(), 'issued_at', floor(extract(epoch from now()))::bigint);
  insert into public.idempotency_keys(organization_id, key, endpoint, request_hash, status_code, response_body, tenant_creation_trusted)
    values (org.id, p_key::text, '/api/v1/admin/tenants:' || p_actor::text,
      decode(p_hash, 'hex'), 201, result, true);
  return result || jsonb_build_object('created', true);
end $$;

revoke all on function public.fn_create_tenant_with_owner(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.fn_create_tenant_with_owner(uuid, uuid, jsonb, text) to service_role;
