-- Achado no changelog upstream (Onda 2, item 2.3): o filtro de etiqueta do
-- Inbox (`GET /api/v1/conversation-tags`) só listava
-- `organizations.settings.canonical_conversation_tags` — o vocabulário
-- CADASTRADO na tela de Configurações. Uma etiqueta aplicada direto numa
-- conversa (edição avulsa, import, automação) sem nunca ter sido cadastrada
-- lá não aparecia como opção de filtro — mesmo já estando em uso.
--
-- `EXPLAIN` contra o plano real (organização com GIN em `conversations.tags`
-- já existente desde antes desta migration — `idx_conversations_org_last_msg`
-- cobre o filtro por organização_id e a varredura unnest+distinct é barata)
-- confirmou que NENHUM índice novo é necessário: o planner já escolhe um
-- index scan por organização + hash aggregate. Só falta expor o dado — o
-- PostgREST não fala `unnest`/`array_agg(distinct ...)` pela REST API, daí a
-- função.
--
-- SECURITY INVOKER de propósito: a RLS de `conversations` já restringe por
-- organização do usuário chamador — mesmo se alguém passasse o `p_org` de
-- outra organização, a política de leitura devolveria zero linhas. O filtro
-- explícito por `organization_id` aqui é defesa em profundidade, não a única
-- trava (mesma dupla camada que `fn_configurar_pre_go_live_canal` já usa).
create or replace function public.fn_tags_de_conversa_em_uso(p_org uuid)
returns text[]
language sql
security invoker
stable
set search_path = ''
as $$
  select coalesce(array_agg(distinct t order by t), '{}'::text[])
    from public.conversations, unnest(tags) as t
   where organization_id = p_org;
$$;

revoke execute on function public.fn_tags_de_conversa_em_uso(uuid) from public, anon;
grant execute on function public.fn_tags_de_conversa_em_uso(uuid) to authenticated, service_role;
