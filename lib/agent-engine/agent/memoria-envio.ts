/**
 * Memória de envio para a régua `near-dup.ts` — I/O de banco, irmão da régua pura.
 *
 * ## A janela "desde a última inbound do cliente"
 *
 * Um turno fresco que responde a uma mensagem NOVA começa com a janela VAZIA: a
 * inbound mais nova acabou de chegar e nada foi enviado depois dela. Então a
 * régua não suprime resposta legítima a pergunta nova — só dentro do turno a
 * memória cresce, pegando a repetição da correção do turno mudo.
 *
 * Um follow-up agendado que re-responde uma conversa CALADA tem a janela CHEIA:
 * a última inbound é antiga e tudo o que o agente disse desde então (inclusive a
 * resposta que já endereçou a mesma pergunta) está na memória. Se o follow-up
 * quase repete o que já saiu, a régua suprime — é a re-resposta redundante
 * medida em produção (o follow-up de promessa re-respondeu a mesma pergunta).
 *
 * O janelamento temporal (limite + janelaMs) mantém "não suprimir resposta futura
 * legítima sobre o mesmo tópico" sob controle: só o que é quase idêntico E recente
 * suprime, nunca assunto parecido com redação diferente.
 *
 * Mensagem que FALHOU (`status = 'failed'`, gravado por `session-reconciler`/
 * `queue` quando o envio não chegou) NÃO é resposta: ela fica de fora da janela,
 * senão uma falha bloquearia a próxima tentativa legítima (#2996, item 4). Só o
 * `'failed'` explícito é excluído — status nulo (linha antiga) ou outro estado
 * segue contando.
 */
import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'>;

/** Quantas outbound recentes entram na memória (mais recentes primeiro). */
const LIMITE_PADRAO = 15;
/** Janela de tempo: 7 dias — cobre follow-up de promessa sem apelar a resto antigo. */
const JANELA_PADRAO_MS = 7 * 24 * 60 * 60 * 1000;

export interface MemoriaEnvioAlvo {
  organizationId: string;
  conversationId: string;
}

/**
 * Corpos das outbound enviadas a ESTA conversa DESDE a última inbound do cliente
 * (e dentro da janela de tempo), mais recentes primeiro. Promessa de:
 * - vazio num turno fresco que responde mensagem nova (nada saiu depois dela);
 * - populado num follow-up que re-responde conversa calada (o que o agente já
 *   disse desde a última fala do cliente).
 *
 * Não-fatal por construção: quem chama pode envolver em try/catch e degradar para
 * a memória só-do-turno se o banco falhar — dedup parcial é melhor que turno
 * derrubado.
 */
export async function corposEnviadosDesdeUltimaInbound(
  db: Queryable,
  alvo: MemoriaEnvioAlvo,
  opts: { limite?: number; janelaMs?: number } = {},
): Promise<string[]> {
  const limite = opts.limite ?? LIMITE_PADRAO;
  const janelaMs = opts.janelaMs ?? JANELA_PADRAO_MS;
  const { rows } = await db.query<{ body: string | null }>(
    `with ultima_inbound as (
       select max(created_at) as em from messages
        where organization_id = $1 and conversation_id = $2 and direction = 'inbound'
     )
     select m.body
       from messages m
       cross join ultima_inbound u
      where m.organization_id = $1
        and m.conversation_id = $2
        and m.direction = 'outbound'
        and m.created_at > coalesce(u.em, '-infinity'::timestamptz)
        and m.created_at > now() - ($3::bigint * interval '1 millisecond')
        and coalesce(m.status, '') <> 'failed'
      order by m.created_at desc
      limit $4`,
    [alvo.organizationId, alvo.conversationId, janelaMs, limite],
  );
  const corpos = rows.map((r) => r.body ?? '').filter((b) => b.trim() !== '');
  return corpos;
}
