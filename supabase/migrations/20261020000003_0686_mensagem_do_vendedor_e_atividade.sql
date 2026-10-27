-- manifest: **A fala HUMANA do vendedor passa a ser atividade do negócio (issue #2953).** O defeito medido pelo reportador: `crm_leads.last_activity_at` só muda por `fn_update_last_activity_at`, que é o gatilho `trg_update_last_activity_at` em `crm_lead_activities`; a mensagem do vendedor não cria linha lá, e `fn_mark_conversation_message` carimba apenas `contacts.last_activity_at`. Então o negócio trabalhado todo dia (pelo Inbox ou pelo celular) seguia com o relógio parado, e o radar de risco (`lib/leads/radar-de-risco.ts`) — que ordena por `last_activity_at` — o listava como FRIO. Gatilho NOVO em `messages`, sem tocar em nenhuma função existente: `fn_mensagem_do_vendedor_e_atividade`, `security definer` com `search_path` fixo, EXECUTE revogado de public/anon/authenticated e concedido só a service_role. O `when` do gatilho só deixa entrar fala humana de SAÍDA — `sent_via in ('user','crm','external_device')`, `direction = 'outbound'`, `type not in ('reaction','system')` e sem `metadata.historico_importado = 'true'` (IA, automação, reação, aviso de sistema, histórico importado e a fala do CLIENTE ficam de fora). Carimba SÓ o negócio aberto mais recentemente ativo do contato (o topo geral, que é a escolha do roteador quando ele é chamado sem funil preferido) — o topo da ordenação por `coalesce(last_activity_at, created_at)` decrescente, na mesma precisão do roteador (milissegundo, `date_trunc('milliseconds', ...)`), entre os negócios `status = 'open'` do MESMO contato e da MESMA organização; assim o carimbo não muda a decisão do roteador, nem a de quem o chama com o funil padrão —, NÃO carimba NADA quando esse topo está empatado (empate é ambíguo de propósito para o roteador) e nunca retrocede a data (`coalesce(last_activity_at,'-infinity') < new.created_at`). Gate: `tests/invariants/mensagem-do-vendedor-e-atividade.test.ts`, que mede comportamento em Postgres real nos cinco casos do critério e mais reação, sistema, histórico importado, outro contato, outra organização, negócio fechado, o relógio que não anda para trás, os dois abertos de relógios DIFERENTES (ordem preservada, roteador no mesmo negócio) os dois abertos EMPATADOS (nada carimbado, ambiguidade intacta) e os dois abertos separados por microssegundos dentro do MESMO milissegundo (empate para o roteador: nada carimbado). Corpo inteiro espelhado, byte a byte, no apêndice de `supabase/baseline.sql`.

-- ---- a mensagem do vendedor é atividade do negócio (migration 0686, issue #2953) ----
-- O DEFEITO, medido por quem reportou: `crm_leads.last_activity_at` só muda por
-- `fn_update_last_activity_at`, que é o gatilho `trg_update_last_activity_at` em
-- `crm_lead_activities`. A mensagem do vendedor não cria linha lá, e
-- `fn_mark_conversation_message` carimba apenas `contacts.last_activity_at`.
-- Resultado: o negócio trabalhado todo dia — pelo Inbox ou pelo celular
-- conectado — seguia com o relógio parado, e o radar de risco
-- (`lib/leads/radar-de-risco.ts`, que ordena e mede por `last_activity_at`) o
-- listava como FRIO. Alarme falso é o defeito caro aqui: ele ensina quem opera a
-- desconfiar do radar inteiro.
--
-- A REGRA: a fala HUMANA do vendedor quebra o silêncio do negócio. "Humana" é o
-- vocabulário que o resto do produto já usa para separar gente de máquina —
-- `sent_via in ('user', 'crm', 'external_device')`, isto é, o Inbox do CRM e o
-- aparelho conectado.
--
-- CADA LINHA DO `when` QUE VAI ALÉM DE `sent_via`, com sua razão:
--   direction = 'outbound'     A mensagem do CLIENTE não é trabalho do vendedor.
--                              Cliente escrevendo e vendedor calado é o negócio
--                              em risco que o radar EXISTE para apontar: se
--                              inbound carimbasse, o radar ficaria cego
--                              exatamente no caso que ele deve mostrar.
--   type not in ('reaction')   reação de emoji não é fala;
--   type not in ('system')     aviso do sistema/canal não é fala;
--   histórico importado        conversa trazida de fora é passado, não
--                              atendimento de agora. A chave é acordada com quem
--                              importa: `metadata.historico_importado = 'true'`.
--                              (Hoje não há quem a grave neste repositório; o
--                              ramo fica de pé para o dia em que o importador
--                              chegar — tirá-lo seria reabrir a porta por onde o
--                              passado entraria como atendimento.)
--
-- SÓ O TOPO, E SÓ QUANDO ELE É ÚNICO — este é o desenho do arremate, pedido na
-- revisão do PR.
--
-- A primeira versão carimbava TODOS os negócios abertos do contato com o MESMO
-- `new.created_at`. Isso FABRICAVA um empate onde podia não haver nenhum. O
-- roteador — `resolveActiveLeadForContact`, em `lib/leads/active-lead.ts` —
-- decide por `atividade()` = `coalesce(last_activity_at, created_at)`
-- decrescente, preferindo o pipeline default, e trata EMPATE no topo como
-- ambíguo DE PROPÓSITO (`ambiguous_open_leads`): mover o card errado do cliente
-- errado é o único bug visível para o cliente final, então "empatou" não vira
-- "escolhe o primeiro". Efeito medido da versão anterior: depois de UMA fala do
-- vendedor, dois negócios abertos que o roteador compara entre si (os dois no
-- funil padrão, ou nenhum deles) deixavam de ter vencedor, e os treze pontos que
-- usam o roteador paravam de achar o negócio da pessoa.
--
-- A ESCOLHA, e por que ela e não outra: carimbar APENAS o negócio aberto mais
-- recentemente ativo do contato (o topo geral, que é a escolha do roteador
-- quando ele é chamado sem funil preferido). A chave é a mesma de `atividade()`,
-- na mesma precisão (milissegundo) — `coalesce(last_activity_at, created_at)`
-- decrescente, truncada ao milissegundo —, entre os `status = 'open'` do MESMO
-- contato e da MESMA organização. Assim o carimbo não muda a decisão, nem a de
-- quem chama o roteador com o funil padrão: se o topo geral está no funil
-- padrão, ele segue o topo ali; se não está, os negócios do funil padrão não
-- são tocados. O que já era o topo continua o topo, e a ORDEM entre os abertos
-- se preserva.
--
-- POR QUE O MILISSEGUNDO: o roteador compara em milissegundos — `atividade()`
-- faz `new Date(iso).getTime()` —, e o Postgres guarda microssegundos. Sem
-- truncar, dois abertos separados por menos de 1 ms seriam EMPATE para o
-- roteador (`ambiguous_open_leads`) e topo ÚNICO aqui, e o carimbo arbitraria
-- exatamente a ambiguidade que este gatilho promete não arbitrar. Por isso as
-- três leituras da chave abaixo usam `date_trunc('milliseconds', ...)`.
--
-- E NÃO CARIMBA NADA quando o topo está EMPATADO. Empate era ambíguo antes desta
-- mudança e continua ambíguo: resolver ambiguidade alheia escolhendo um dos dois
-- é exatamente o "chute com 50% de chance de mover o card errado" que a regra
-- §3.2 recusa. O gatilho não arbitra o que o produto decidiu não arbitrar.
--
-- NUNCA RETROCEDE: o `where` do `update` casa só negócio cujo relógio é MAIS
-- ANTIGO que a mensagem (`coalesce(last_activity_at, '-infinity') < new.created_at`).
-- Relógio já mais novo fica intocado — nem escrita inútil em `updated_at`. É a
-- mesma assimetria que a 0079 declara: o relógio do negócio só anda para frente.
-- (Um topo único cujo relógio já é mais novo que a mensagem simplesmente não é
-- carimbado: o roteador já o escolheria de qualquer forma.)
--
-- SEM TOQUE NO QUE JÁ EXISTE: `fn_update_last_activity_at` e
-- `fn_mark_conversation_message` ficam como estão. Este é um gatilho NOVO, em
-- outra tabela, com função própria — a lista positiva de tipos de
-- `crm_lead_activities` continua sendo a única régua do que conta como
-- atividade lá.
--
-- ⚠️ E ESTE BLOCO ENTRA ANTES DA VARREDURA anon (migration 0116), que é de
-- propósito o último do arquivo: `create function` depois dela nasceria com
-- EXECUTE para anon e sem quem cure (o `alter default privileges` do corpo grava
-- a concessão no catálogo, e a varredura só alcança o que veio antes). Vigiado
-- por `tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts`.
--
-- `security definer` com `search_path` fixo: o INSERT em `messages` chega tanto
-- com a sessão do usuário quanto com o service role, e o carimbo do negócio não
-- pode depender da policy de quem enviou. O EXECUTE é revogado de public/anon/
-- authenticated e concedido só a service_role — o `alter default privileges` do
-- baseline concede a anon e authenticated toda função nova, então sem o revoke
-- esta nasceria exposta.

create or replace function public.fn_mensagem_do_vendedor_e_atividade()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_topo timestamptz;
  v_quantos integer;
begin
  -- O topo da ordem que o roteador usa — `coalesce(last_activity_at, created_at)`
  -- decrescente, a mesma chave de `atividade()` em `lib/leads/active-lead.ts`, na
  -- mesma precisão (milissegundo) — entre os negócios ABERTOS do MESMO contato e
  -- da MESMA organização.
  select date_trunc('milliseconds', coalesce(l.last_activity_at, l.created_at))
    into v_topo
    from public.crm_leads l
   where l.organization_id = new.organization_id
     and l.contact_id = new.contact_id
     and l.status = 'open'
   order by date_trunc('milliseconds', coalesce(l.last_activity_at, l.created_at)) desc
   limit 1;

  -- Contato sem negócio aberto: nada a carimbar.
  if v_topo is null then
    return new;
  end if;

  -- TOPO EMPATADO: o roteador responde `ambiguous_open_leads`, e é de propósito.
  -- Não se resolve ambiguidade alheia escolhendo um dos lados — o carimbo
  -- criaria um vencedor que o produto recusa escolher.
  select count(*)
    into v_quantos
    from public.crm_leads l
   where l.organization_id = new.organization_id
     and l.contact_id = new.contact_id
     and l.status = 'open'
     and date_trunc('milliseconds', coalesce(l.last_activity_at, l.created_at)) = v_topo;

  if v_quantos <> 1 then
    return new;
  end if;

  -- SÓ O TOPO ÚNICO, e nunca retrocede: negócio com relógio já mais novo que a
  -- mensagem fica intocado, e os demais abertos do contato — que o roteador não
  -- escolheria — também.
  update public.crm_leads l
     set last_activity_at = new.created_at
   where l.organization_id = new.organization_id
     and l.contact_id = new.contact_id
     and l.status = 'open'
     and date_trunc('milliseconds', coalesce(l.last_activity_at, l.created_at)) = v_topo
     and coalesce(l.last_activity_at, '-infinity'::timestamptz) < new.created_at;

  return new;
end$fn$;

comment on function public.fn_mensagem_do_vendedor_e_atividade() is
  'Gatilho de `messages`: a fala humana do vendedor (sent_via em user/crm/external_device, outbound, sem reação/sistema/histórico importado) carimba `crm_leads.last_activity_at` do negócio ABERTO mais recentemente ativo do contato, na mesma organização — o topo da ordenação por coalesce(last_activity_at, created_at), truncada ao milissegundo como o roteador a compara —, e nunca retrocede a data. Topo empatado ou contato sem negócio aberto: não carimba nada. Existe porque `crm_lead_activities` nunca recebeu linha de mensagem e o radar de risco lia o negócio trabalhado como frio (#2953).';

revoke execute on function public.fn_mensagem_do_vendedor_e_atividade() from public, anon, authenticated;
grant execute on function public.fn_mensagem_do_vendedor_e_atividade() to service_role;

drop trigger if exists trg_mensagem_do_vendedor_e_atividade on public.messages;
create trigger trg_mensagem_do_vendedor_e_atividade
  after insert on public.messages
  for each row
  when (new.direction = 'outbound'
        and new.sent_via in ('user', 'crm', 'external_device')
        and new.type not in ('reaction', 'system')
        and coalesce(new.metadata ->> 'historico_importado', '') <> 'true')
  execute function public.fn_mensagem_do_vendedor_e_atividade();

notify pgrst, 'reload schema';
