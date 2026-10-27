-- manifest: **Desmarcar uma conversa como exemplo para a IA tira do RAG os trechos que já tinham sido aprendidos dela (#3042, Refs #3006).** A rota `POST /conversations/[id]/usable-for-rag` com `enabled=false` só zerava a flag, o que impede as ingestões FUTURAS; os `ai_chunks` já gravados com `metadata.conversation_id` daquela conversa seguiam alcançáveis por `retrieve_top_k_chunks`. A função nova `fn_conversa_remove_trechos_do_rag` apaga esses trechos (na mesma organização) e devolve a contagem, que a rota leva para a resposta e para a auditoria `conversation.usable_for_rag_toggled`. Mesmo molde da 0564 (#2394, contato pessoal). Idempotente: `create or replace`; apêndice igual no fim do `baseline.sql`.

-- ============================================================================
-- 0688 — DESMARCAR O EXEMPLO TIRA OS TRECHOS JÁ APRENDIDOS DO RAG (#3042)
--
-- O defeito: desmarcar `usable_for_rag` impede só as ingestões FUTURAS (o lote
-- de `lib/ai/rag/ingest/conversations.ts` lê `usable_for_rag = true`). Os
-- trechos já ingeridos ficavam em `ai_chunks`, e `retrieve_top_k_chunks`, que
-- filtra só organização e versão, continuava trazendo-os ao agente. Com o botão
-- na lista de conversas (#3042), o aviso "A conversa deixou de ser exemplo para
-- a IA." passa a prometer que o agente não usa mais aquela conversa.
--
-- O recorte é a CONVERSA, por `metadata.conversation_id` (o campo que a
-- ingestão grava), e só se a conversa é da organização passada: uma fonte de
-- conversas tem trechos de várias, e apagar a fonte levaria o que é das outras.
--
-- A guarda de papel vale para quem chama com sessão (`auth.uid()` não nulo):
-- `agent`, o mesmo papel que a rota exige para marcar e desmarcar. A rota chama
-- pelo admin client, com o org resolvido da sessão, nunca do corpo.
-- ============================================================================

create or replace function public.fn_conversa_remove_trechos_do_rag(p_org uuid,p_conversation uuid)
returns integer language plpgsql security definer set search_path=public as $$
declare removidos integer;
begin
 if auth.uid() is not null and not public.fn_role_at_least(p_org,'agent') then
  raise exception 'caller_not_authorized_for_org'
    using hint = 'fn_conversa_remove_trechos_do_rag: caller must be agent of the organization';
 end if;
 delete from public.ai_chunks c
  where c.organization_id=p_org
    and c.metadata->>'conversation_id'=p_conversation::text
    and exists (select 1 from public.conversations v
                 where v.id=p_conversation and v.organization_id=p_org);
 get diagnostics removidos = row_count;
 return removidos;
end $$;
revoke all on function public.fn_conversa_remove_trechos_do_rag(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_conversa_remove_trechos_do_rag(uuid,uuid) to service_role;

notify pgrst,'reload schema';
