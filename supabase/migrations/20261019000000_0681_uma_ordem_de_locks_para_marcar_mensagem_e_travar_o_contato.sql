-- manifest: **Uma ordem de locks so para marcar a mensagem e travar o contato (issue #2884).** A `fn_mark_conversation_message` (0267) travava a CONVERSA (`for no key update`) e depois o CONTATO (`update contacts set last_activity_at`); o gatilho do contato criado pela 0645 (`trg_contato_atualiza_trava_nas_conversas`) faz o INVERSO — trava o contato no proprio UPDATE e so entao atualiza as conversas dele. Com as duas rodando ao mesmo tempo sobre o mesmo contato (a mensagem que chega junto de uma passagem para humano/STOP, ou, com a 0658 na main, da criacao de conversa nova) o Postgres fecha o ciclo AB-BA e derruba uma das transacoes com 40P01 — e, se a vitima e a passagem para humano, A TRAVA NAO E GRAVADA. Medido no pg15 do `pnpm test:db`, com duas sessoes reais: a ordem da 0267 fechava o ciclo (40P01) e a desta migration nao. A funcao passa a travar o CONTATO antes da CONVERSA — a unica ordem unificavel, porque o gatilho do contato e AFTER UPDATE (o contato ja esta travado quando ele roda, e a ordem dele nao da para trocar) e a criacao de conversa ja trava o contato antes de inserir a conversa. O contato ja era travado pela funcao no fim; a trava so sobe de lugar, sem lock novo no caminho quente — o unico custo e travar o contato no raro retorno cedo de mensagem atrasada, que antes nao o tocava. Gate: `tests/invariants/uma-ordem-de-locks.test.ts` (duas sessoes reais; VERMELHO com a ordem inversa).

-- 0681: uma ordem de locks para marcar a mensagem e travar o contato (issue #2884).
--
-- Detalhe completo no cabecalho do bloco abaixo; o bloco e o MESMO, letra a
-- letra, no apendice de `supabase/baseline.sql` — e ele que o `update.sh`
-- reaplica a cada atualizacao, inclusive em quem nunca vai rodar migrations.

-- ---- uma ordem de locks para marcar a mensagem e travar o contato (migration 0681, issue #2884) ----
-- A 0645 deu ao contato um gatilho que, ao gravar `force_human`/`is_blocked`,
-- trava o CONTATO (o proprio UPDATE) e so entao atualiza as CONVERSAS dele
-- (`trg_contato_atualiza_trava_nas_conversas`). A `fn_mark_conversation_message`
-- (0267) fazia o contrario: travava a CONVERSA (`for no key update`) e DEPOIS o
-- CONTATO (`update contacts set last_activity_at`). As duas ordens, opostas,
-- fecham um ciclo AB-BA quando rodam ao mesmo tempo sobre o mesmo contato: a
-- ingestao segura a conversa e pede o contato, a passagem para humano (ou o
-- STOP) segura o contato e pede a conversa — o Postgres derruba uma das
-- transacoes com 40P01. Se a vitima e a passagem para humano, A TRAVA NAO E
-- GRAVADA; com a 0658 na main, a criacao de conversa nova (que le o contato com
-- `for share`) tambem entra como vitima.
--
-- UMA ordem so para os DOIS caminhos: o CONTATO primeiro, a CONVERSA depois.
-- Nao ha escolha entre "inverter a funcao" e "inverter o gatilho": o gatilho do
-- contato e AFTER UPDATE, entao o contato JA esta travado quando ele roda — a
-- ordem dele (contato -> conversa) e imposta pelo UPDATE que o dispara e nao da
-- para trocar. A unica ordem unificavel e contato -> conversa, e e ela que a
-- funcao passa a seguir: a mesma que a criacao de conversa ja usa (o upsert de
-- contato trava o contato antes do INSERT da conversa). O contato ja era
-- travado por esta funcao no fim; a trava so sobe de lugar — nenhum lock novo no
-- caminho quente, e o unico custo e travar o contato no raro retorno cedo de
-- mensagem atrasada (que antes nao o tocava).
create or replace function public.fn_mark_conversation_message(p_conv uuid,p_direction text,p_preview text,p_at timestamptz)
returns void language plpgsql security definer set search_path=public as $$
declare c public.conversations; pre_contact uuid;
begin
 select * into c from public.conversations where id=p_conv;
 if not found then return; end if;
 pre_contact:=c.contact_id;
 perform public.fn_service_lock(c.organization_id,c.contact_id);
 -- ORDEM UNICA (issue #2884): o CONTATO antes da CONVERSA. O gatilho do
 -- contato (trg_contato_atualiza_trava_nas_conversas, 0645) e AFTER UPDATE:
 -- ele trava o contato no proprio UPDATE e so entao toca as conversas. Travar
 -- a conversa antes do contato (a forma da 0267) fechava o ciclo AB-BA com a
 -- passagem para humano e derrubava uma das transacoes com 40P01. Travar o
 -- contato aqui, no mesmo modo `for no key update` que o UPDATE do gatilho
 -- usa, poe as duas no MESMO sentido.
 perform 1 from public.contacts
   where id=pre_contact and organization_id=c.organization_id
   for no key update;
 select * into c from public.conversations where id=p_conv for no key update;
 if c.contact_id is distinct from pre_contact then raise exception 'service_contact_changed' using errcode='40001'; end if;
 if p_direction='inbound' and p_at<=c.service_closed_at then return; end if;
 update public.conversations set
  last_message_at=greatest(last_message_at,p_at),
  last_message_preview=case when last_message_at is null or p_at>=last_message_at then p_preview else last_message_preview end,
  last_inbound_at=case when p_direction='inbound' then greatest(last_inbound_at,p_at) else last_inbound_at end,
  last_outbound_at=case when p_direction='outbound' then greatest(last_outbound_at,p_at) else last_outbound_at end,
  unread_count_for_assignee=case when p_direction='inbound' then unread_count_for_assignee+1 when p_direction='outbound' then 0 else unread_count_for_assignee end,
  -- A régua da Fila (issue #990). Os três ramos do inbound, na ordem:
  --   1. mensagem ATRASADA (escrita antes da última resposta) — já respondida,
  --      não é espera: mantém o que havia;
  --   2. a espera guardada é de uma mensagem SEM RESPOSTA deste atendimento —
  --      o cliente insistiu: fica o começo da espera, o mais ANTIGO dos dois;
  --   3. não havia espera (tudo respondido) ou ela é de um atendimento já
  --      encerrado: a espera de agora começa nesta mensagem.
  -- E o outbound: resposta anterior à espera guardada não a responde (fora de
  -- ordem, mantém); qualquer outra responde tudo até aqui, e a coluna volta ao
  -- last_inbound_at — "não há mensagem sem resposta".
  awaiting_since=case
    when p_direction='inbound' then
      case
        when p_at<=coalesce(c.last_outbound_at,'-infinity'::timestamptz) then
          coalesce(c.awaiting_since,greatest(coalesce(c.last_inbound_at,'-infinity'::timestamptz),p_at))
        when c.awaiting_since>coalesce(c.last_outbound_at,'-infinity'::timestamptz)
         and c.awaiting_since>coalesce(c.service_closed_at,'-infinity'::timestamptz) then
          least(c.awaiting_since,p_at)
        else p_at
      end
    else
      case
        when c.awaiting_since is not null and p_at<c.awaiting_since then c.awaiting_since
        else c.last_inbound_at
      end
  end
 where id=p_conv and organization_id=c.organization_id;
 update public.contacts set last_activity_at=greatest(last_activity_at,p_at)
 where id=c.contact_id and organization_id=c.organization_id;
end; $$;
revoke execute on function public.fn_mark_conversation_message(uuid,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_mark_conversation_message(uuid,text,text,timestamptz) to service_role;
