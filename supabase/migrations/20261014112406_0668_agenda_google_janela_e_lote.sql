-- manifest: A leitura incremental da agenda do Google mantém só a janela ativa e grava cada página em lote (`fn_google_calendar_page_batch`, só service_role), limpando o cache fora da janela. Os cursores antigos são zerados UMA vez (guarda: a função ainda não existir), para o update.sh não forçar releitura a cada atualização. `calendar_connections.catalog_retry_at` dá recuo de 15 min à leitura do catálogo que falha, que com o cron de 1 min seria repetida a cada tick. Gates: tests/unit/agenda-google-cota-por-hora.test.ts, tests/invariants/agenda-google-recovery.test.ts (I3) e titulo-do-evento-pessoal-fora-do-alcance.test.ts.

-- A API expande uma série em muitas instâncias quando singleEvents=true. O
-- syncToken não aceita timeMin/timeMax, então uma série alterada podia enfileirar
-- ocorrências décadas à frente. A página continua sendo consumida, mas o cache
-- guarda somente a janela do cursor (90 dias na leitura completa diária).
--
-- Uma única RPC aplica a página, remove linhas fora da janela e avança o cursor
-- sob o mesmo fence. Isso evita centenas de viagens HTTP ao PostgREST por página.

-- Cursors criados pela leitura expansiva podem apontar para um backlog enorme.
-- Reconstrói uma vez com timeMin/timeMax; o cache existente permanece até o
-- ciclo full concluir e a limpeza por geração preservar a ocupação nesse meio.
-- Roda UMA vez: só enquanto a função de baixo ainda não existe. O update.sh
-- reaplica este apêndice em toda atualização, e um update solto zeraria os
-- cursores a cada uma, forçando a releitura completa e o aviso "Atualizando
-- a cobertura" de novo.
do $reset_0668$
begin
  if to_regprocedure('public.fn_google_calendar_page_batch(uuid,uuid,jsonb)') is null then
    update public.calendar_connection_calendars set sync_token=null,sync_cursor=null,
     sync_coverage=null,sync_next_attempt_at=now(),
     sync_error='Atualizando a cobertura da agenda após alteração da sincronização.'
     where sync_token is not null or sync_cursor is not null;
  end if;
end $reset_0668$;

create or replace function public.fn_google_calendar_page_batch(p_org uuid,p_id uuid,p_args jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
 c public.calendar_connection_calendars;
 v_cursor jsonb;
 item jsonb;
 result jsonb;
 window_start timestamptz;
 window_end timestamptz;
 prune_ids text[];
begin
 v_cursor:=p_args->'cursor';
 if v_cursor is null or jsonb_typeof(v_cursor)<>'object' then
  raise exception 'google_cursor_missing' using errcode='22023';
 end if;
 if jsonb_typeof(coalesce(p_args->'items','[]'::jsonb))<>'array'
  or jsonb_typeof(coalesce(p_args->'prune_ids','[]'::jsonb))<>'array' then
  raise exception 'google_page_invalid' using errcode='22023';
 end if;
 window_start:=(v_cursor->>'window_start')::timestamptz;
 window_end:=(v_cursor->>'window_end')::timestamptz;
 if window_start is null or window_end is null or window_end<=window_start then
  raise exception 'google_window_invalid' using errcode='22023';
 end if;

 -- Valida tenant, conexão, claim e cursor antes de qualquer efeito.
 perform public.fn_google_calendar(p_org,p_id,'renew',
  jsonb_build_object('claim',p_args->'claim','cursor',v_cursor));
 select * into c from public.calendar_connection_calendars
  where organization_id=p_org and id=p_id;
 if not found then raise exception 'google_calendar_not_found' using errcode='P0002';end if;

 prune_ids:=array(select jsonb_array_elements_text(coalesce(p_args->'prune_ids','[]'::jsonb)));
 for item in select value from jsonb_array_elements(coalesce(p_args->'items','[]'::jsonb)) loop
  if coalesce(item->>'status','confirmed')<>'cancelled'
   and ((item->>'starts_at')::timestamptz>=window_end or (item->>'ends_at')::timestamptz<=window_start) then
   if coalesce(item->>'external_event_id','')<>'' then
    prune_ids:=array_append(prune_ids,item->>'external_event_id');
   end if;
  else
   perform public.fn_google_calendar(p_org,p_id,'item',
    jsonb_build_object('claim',p_args->'claim','cursor',v_cursor,'item',item));
  end if;
 end loop;

 if cardinality(prune_ids)>0 then
  delete from public.calendar_external_events
   where organization_id=p_org and connection_id=c.connection_id
    and external_calendar_id=c.external_calendar_id and external_event_id=any(prune_ids);
 end if;

 result:=public.fn_google_calendar(p_org,p_id,'page',
  p_args-'items'-'prune_ids');

 -- Limpa também o cache legado já gravado fora da janela. Eventos do Google
 -- não ocupam horário fora da cobertura usada pelo motor de disponibilidade.
 delete from public.calendar_external_events
  where organization_id=p_org and connection_id=c.connection_id
   and external_calendar_id=c.external_calendar_id and starts_at is not null
   and (starts_at>=window_end or ends_at<=window_start);
 return result;
end;$$;
revoke execute on function public.fn_google_calendar_page_batch(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.fn_google_calendar_page_batch(uuid,uuid,jsonb) to service_role;

-- Recuo da leitura da lista de agendas. Só `fn_google_catalog` grava
-- `catalog_checked_at`, e só quando dá certo: uma falha (429, 5xx, 403 do
-- Google) deixava o catálogo vencido e a rota o tentava de novo a cada tick.
-- Com o cron de 1 min, seriam 60 tentativas e 60 audits por hora, em vez de 4.
-- A rota grava aqui "não tente antes de" quando a leitura do catálogo falha.
alter table public.calendar_connections add column if not exists catalog_retry_at timestamptz;
comment on column public.calendar_connections.catalog_retry_at is
  'Não tentar ler a lista de agendas do Google antes deste instante. Gravado pela rota agenda-google-sync quando a leitura do catálogo falha; NULL ou passado = pode tentar.';

notify pgrst,'reload schema';
