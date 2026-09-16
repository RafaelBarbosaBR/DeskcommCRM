-- ---- Aniversário do contato dispara automação (Onda 4.4) ----
--
-- `fn_aniversariantes_do_dia(p_org, p_mes, p_dia)` — o cron
-- `app/api/v1/cron/contact-birthdays/route.ts` chama esta função uma vez por
-- organização, só quando o relógio local dela marca 9h (`lib/agenda/fuso.ts`
-- decide isso em memória, sem SQL). O PostgREST não fala `extract(month from
-- birthdate) = X` direto num `.eq()` de coluna — é exatamente a mesma classe
-- de gap que `fn_tags_de_conversa_em_uso` (migration 0250) resolveu para
-- `unnest`/`distinct`.
--
-- `security invoker`: quem chama é sempre o worker (service role, que
-- bypassa RLS de qualquer jeito) e `p_org` filtra explicitamente — mesma
-- doutrina de `fn_tags_de_conversa_em_uso`.
--
-- Contato bloqueado, anonimizado ou mesclado em outro NUNCA entra: mandar
-- "feliz aniversário" para quem bloqueou o número, para um registro que a
-- LGPD já apagou o nome, ou para um id morto (mesclado) é o tipo de mensagem
-- que gera reclamação, não conversão.

create or replace function public.fn_aniversariantes_do_dia(p_org uuid, p_mes int, p_dia int)
returns table(contact_id uuid)
language sql
security invoker
stable
as $$
  select id
    from public.contacts
   where organization_id = p_org
     and birthdate is not null
     and extract(month from birthdate) = p_mes
     and extract(day from birthdate) = p_dia
     and is_blocked = false
     and is_anonymized = false
     and is_merged_into is null;
$$;

revoke all on function public.fn_aniversariantes_do_dia(uuid, int, int) from public, anon;
grant execute on function public.fn_aniversariantes_do_dia(uuid, int, int) to authenticated, service_role;

notify pgrst, 'reload schema';
