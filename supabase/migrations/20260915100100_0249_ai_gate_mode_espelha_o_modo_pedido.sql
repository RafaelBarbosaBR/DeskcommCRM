-- Achado no changelog upstream (Onda 2, item 2.2): `fn_configurar_pre_go_live_canal`
-- (migration 0218) gravava `metadata.ai_gate_mode = 'pre_go_live'`
-- INCONDICIONALMENTE, mesmo quando `p_modo = 'open'` — abrir o canal para o
-- público deixava `ai_gate` correto ('open') mas `ai_gate_mode` mentindo
-- ('pre_go_live') para sempre.
--
-- Hoje é bug LATENTE, não observável: `lerModoDeAcessoDaIa`
-- (lib/ai/elegibilidade/pre-go-live.ts) checa `ai_gate` primeiro e só olha
-- `ai_gate_mode` quando `ai_gate='allowlist'` — então nenhum consumidor atual
-- lê o valor errado. Mas é exatamente o tipo de defeito que uma leitura
-- futura, mais direta, herdaria sem aviso nenhum. `create or replace`
-- corrige a condição: `ai_gate_mode` passa a espelhar `p_modo` de verdade.
create or replace function public.fn_configurar_pre_go_live_canal(
  p_org uuid,
  p_canal uuid,
  p_modo text,
  p_numeros text[]
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_linhas integer;
  v_gate text;
begin
  if p_modo is null or p_modo not in ('open', 'pre_go_live') then
    raise exception 'modo de acesso da IA inválido' using errcode = '22023';
  end if;

  if p_numeros is null or exists (
    select 1
      from unnest(p_numeros) as n(numero)
     where numero is null or numero !~ '^\+[1-9][0-9]{7,14}$'
  ) then
    raise exception 'lista de telefones de teste inválida' using errcode = '22023';
  end if;

  v_gate := case when p_modo = 'pre_go_live' then 'allowlist' else 'open' end;

  update public.channel_sessions
     set metadata = jsonb_set(
       jsonb_set(
         jsonb_set(coalesce(metadata, '{}'::jsonb), '{ai_gate}', to_jsonb(v_gate), true),
         '{ai_gate_mode}', to_jsonb(p_modo), true
       ),
       '{ai_test_phone_numbers}', to_jsonb(p_numeros), true
     )
   where organization_id = p_org
     and id = p_canal
     and archived_at is null;

  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$$;

revoke execute on function public.fn_configurar_pre_go_live_canal(uuid, uuid, text, text[])
  from public, anon, authenticated;
grant execute on function public.fn_configurar_pre_go_live_canal(uuid, uuid, text, text[])
  to service_role;
