/**
 * CONVERSA ARQUIVADA NÃO VIRA PENDÊNCIA ABERTA NO RADAR (#2822).
 *
 * ## O defeito que este invariante existe para barrar (medido, não hipotético)
 *
 * O backfill R2 do apêndice "Índice de Atrito + DEMANDAS" deriva uma demanda de
 * toda conversa que nunca escalou — e o `case cv.status` dele só conhece
 * `resolved`/`closed` como terminais. Conversa `archived` sem demanda anterior
 * caía no `else 'aberta'`, com desfecho e fechada_em NULL. Depois do
 * `update.sh`, essa derivada aparecia na consulta de pendências do Radar como
 * trabalho a fazer — embora arquivar seja operação normal do atendimento.
 *
 * Medido no baseline 0c05ca348: a ÚNICA guarda `status <> 'archived'` do
 * arquivo inteiro pertence a uma constraint de `is_active` (baseline.sql
 * ~16774), nada a ver com R2. O R2 não filtrava `archived`.
 *
 * ## O conserto e o que ele NÃO faz
 *
 * Uma linha na origem do R2: `where cv.status <> 'archived'`. Conversa
 * arquivada sem demanda anterior não gera demanda derivada. A migração 0136
 * fica intocada (a issue é explícita), a cadeia R1/R3 não é reescrita, a
 * consulta de pendências do Radar não muda — o conserto é na FONTE, não no
 * consumo — e nenhuma migração nova nasce: o alvo é o backfill do baseline.
 * Conversa arquivada que recebe mensagem nova reabre pelo `fn_service_inbound`
 * de sempre e a demanda inbound nasce no tenant certo.
 *
 * ## Como este arquivo mede
 *
 * O bloco é EXTRAÍDO do `supabase/baseline.sql` — o mesmo apêndice que o
 * `update.sh` re-aplica em todo clone — e EXECUTADO dentro de transação
 * revertida. Não reimplementado: reimplementar mediria a minha cópia, e a
 * cópia continuaria certa com o baseline sabotado (modo mais comum de um teste
 * de migration ficar decorativo).
 *
 * ## Qual caso guarda o quê
 *
 *  1. controle positivo: open/claimed/closed/resolved SEM demanda anterior
 *     continuam virando demanda — sem isto, um R2 apagado ficaria verde.
 *  2. o guard: conversa archived SEM demanda anterior NÃO vira pendência.
 *     É o caso vermelho sem a mudança.
 *  3. idempotência: reaplicar o backfill (o `update.sh` de todo clone) não
 *     muda nada — o guard extra não quebra a reaplicação.
 *  4. preservação: demanda ANTERIOR compartilhada em 2 canais + card fica
 *     intacta — o conserto não encerra, não desvincula, não reescreve.
 *  5. reabertura: mensagem nova na conversa arquivada reabre pelo caminho
 *     nativo e a demanda nasce no tenant certo (organization_id preservado).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, seedGov, sql } from "./gov-helpers";

const MARCADOR_INICIO = "-- ---- Índice de Atrito + DEMANDAS";
/** Todo rótulo de bloco do apêndice tem esta forma; o próximo encerra o nosso. */
const MARCADOR_PROXIMO = "\n-- ---- ";

/** O bloco do apêndice que o `update.sh` re-aplica, lido do arquivo de verdade. */
function blocoDoApendice(): string {
  const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
  const inicio = baseline.indexOf(MARCADOR_INICIO);
  if (inicio < 0) {
    throw new Error(
      `marcador ${MARCADOR_INICIO} não encontrado em supabase/baseline.sql — ` +
        "a extração não pode devolver bloco vazio em silêncio",
    );
  }
  const fim = baseline.indexOf(MARCADOR_PROXIMO, inicio + MARCADOR_INICIO.length);
  const bloco = fim < 0 ? baseline.slice(inicio) : baseline.slice(inicio, fim);
  // Sem estas conferências, um bloco truncado passaria como "não derivou nada".
  if (!/insert into public\.demandas/.test(bloco)) {
    throw new Error("bloco extraído não contém o insert de demandas (extração quebrada)");
  }
  if (!/'derivada'/.test(bloco)) {
    throw new Error("bloco extraído não contém o backfill R2 (extração quebrada)");
  }
  return bloco;
}

// Namespace pela ISSUE (#2822): a correção não nasce de migração nova, então o
// número da migração não existe para bater — o da issue é o único estável.
// UUIDs escritos à mão porque os arquivos de invariante dividem o container e
// `on conflict do nothing` engole colisão em silêncio (issue #207).
const SESSAO_2 = "2822aaaa-2222-4000-8000-000000000002";
const CT_OPEN = "2822aaaa-0000-4000-8000-000000000001";
const CT_CLAIMED = "2822aaaa-0000-4000-8000-000000000002";
const CT_CLOSED = "2822aaaa-0000-4000-8000-000000000003";
const CT_RESOLVED = "2822aaaa-0000-4000-8000-000000000004";
/** Conversa archived SEM demanda anterior: o caso vermelho sem a mudança. */
const CT_ARQUIVADA = "2822aaaa-0000-4000-8000-000000000005";
/** Contato cuja demanda nasceu na fala dos DOIS canais e foi arquivada depois. */
const CT_COMPART = "2822aaaa-0000-4000-8000-000000000006";
const CV_OPEN = "2822aaaa-1111-4000-8000-000000000001";
const CV_CLAIMED = "2822aaaa-1111-4000-8000-000000000002";
const CV_CLOSED = "2822aaaa-1111-4000-8000-000000000003";
const CV_RESOLVED = "2822aaaa-1111-4000-8000-000000000004";
const CV_ARQUIVADA = "2822aaaa-1111-4000-8000-000000000005";
const CV_COMPART_1 = "2822aaaa-1111-4000-8000-000000000006";
const CV_COMPART_2 = "2822aaaa-1111-4000-8000-000000000007";
const MSG_COMPART_1 = "2822aaaa-3333-4000-8000-000000000001";
const MSG_COMPART_2 = "2822aaaa-3333-4000-8000-000000000002";
const MSG_REABERTA = "2822aaaa-3333-4000-8000-000000000003";

const CONTROLES: ReadonlyArray<readonly [string, string, string, string]> = [
  // [contato, conversa, estado esperado da derivada, desfecho esperado]
  [CT_OPEN, CV_OPEN, "aberta", ""],
  [CT_CLAIMED, CV_CLAIMED, "aberta", ""],
  [CT_CLOSED, CV_CLOSED, "encerrada", "resolvida"],
  [CT_RESOLVED, CV_RESOLVED, "resolvida", "resolvida"],
];
const CONTATOS_CONTROLE = CONTROLES.map(([ct]) => `'${ct}'`).join(", ");
const TODOS_CONTATOS = `${CONTATOS_CONTROLE}, '${CT_ARQUIVADA}', '${CT_COMPART}'`;
const TODAS_CONVERSAS = `'${CV_OPEN}', '${CV_CLAIMED}', '${CV_CLOSED}', '${CV_RESOLVED}', '${CV_ARQUIVADA}', '${CV_COMPART_1}', '${CV_COMPART_2}'`;

/**
 * Roda o script, aplica o bloco extraído dentro de transação REVERTIDA e
 * devolve os pares `chave|valor` dos `select` finais.
 *
 * `psql -tA` também imprime as tags de comando (`INSERT 0 3`, `BEGIN`,
 * `ROLLBACK`) no stdout; o filtro é a própria forma do par — linha sem `|` ou
 * com chave que não parece rótulo não entra.
 */
function medir(rotina: { antes?: string; depois: string }): Record<string, string> {
  const bloco = blocoDoApendice();
  const saida = sql(`
    begin;
    ${rotina.antes ?? ""}
    ${bloco}
    ${rotina.depois}
    rollback;
  `);
  const medidas: Record<string, string> = {};
  for (const linha of saida.split("\n")) {
    const [chave, ...resto] = linha.split("|");
    // Hífen entra na chave: os rótulos dos controles embutem o UUID do contato.
    if (chave !== undefined && resto.length > 0 && /^[a-z0-9_-]+$/.test(chave.trim())) {
      medidas[chave.trim()] = resto.join("|").trim();
    }
  }
  return medidas;
}

/** Contagem de demandas do contato, sem transação (estado comprometido do seed). */
function demandasAgora(contato: string): number {
  const out = sql(`select count(*) from public.demandas where contact_id = '${contato}';`);
  const ultima = out.split("\n").pop() ?? "";
  if (!/^\d+$/.test(ultima.trim())) throw new Error(`contagem inesperada: ${out}`);
  return Number(ultima.trim());
}

beforeAll(() => {
  seedGov();
  sql(`
    delete from public.messages where conversation_id in (${TODAS_CONVERSAS});
    delete from public.demanda_conversas where conversation_id in (${TODAS_CONVERSAS});
    delete from public.demandas where contact_id in (${TODOS_CONTATOS});
    delete from public.conversations where id in (${TODAS_CONVERSAS});
    delete from public.contacts where id in (${TODOS_CONTATOS});
    delete from public.channel_sessions where id = '${SESSAO_2}';

    insert into public.contacts (id, organization_id, display_name) values
      ('${CT_OPEN}', '${GOV_ORG}', '2822 controle open'),
      ('${CT_CLAIMED}', '${GOV_ORG}', '2822 controle claimed'),
      ('${CT_CLOSED}', '${GOV_ORG}', '2822 controle closed'),
      ('${CT_RESOLVED}', '${GOV_ORG}', '2822 controle resolved'),
      ('${CT_ARQUIVADA}', '${GOV_ORG}', '2822 arquivada sem demanda'),
      ('${CT_COMPART}', '${GOV_ORG}', '2822 demanda compartilhada');

    -- DO + exception (não ON CONFLICT): channel_sessions tem unique DEFERRABLE
    -- (phone_per_org), que ON CONFLICT sem arbiter rejeita — mesma forma do
    -- seedGov.
    do $gov$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_2}', '${GOV_ORG}', 'gov-inv-2822', '\\x00'::bytea);
    exception when unique_violation then null; end $gov$;

    -- Todas nascem 'open'; os estados terminais chegam pelo MESMO comando
    -- nativo da porta de API (fn_service_status), que carimba
    -- status_changed_at/service_closed_at como a produção carimba. Insert à mão
    -- já 'closed' deixaria status_changed_at NULL e o R2 estouraria em
    -- demandas_desfecho_coerente (desfecho = 'resolvida' com fechada_em NULL).
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status) values
      ('${CV_OPEN}', '${GOV_ORG}', '${CT_OPEN}', '${GOV_SESSION}', 'open'),
      ('${CV_CLAIMED}', '${GOV_ORG}', '${CT_CLAIMED}', '${GOV_SESSION}', 'open'),
      ('${CV_CLOSED}', '${GOV_ORG}', '${CT_CLOSED}', '${GOV_SESSION}', 'open'),
      ('${CV_RESOLVED}', '${GOV_ORG}', '${CT_RESOLVED}', '${GOV_SESSION}', 'open'),
      ('${CV_ARQUIVADA}', '${GOV_ORG}', '${CT_ARQUIVADA}', '${GOV_SESSION}', 'open'),
      ('${CV_COMPART_1}', '${GOV_ORG}', '${CT_COMPART}', '${GOV_SESSION}', 'open'),
      ('${CV_COMPART_2}', '${GOV_ORG}', '${CT_COMPART}', '${SESSAO_2}', 'open');

    -- A demanda compartilhada nasce pelo caminho NATIVO: a mensagem no canal 1
    -- dispara trg_demanda_abre_no_inbound → fn_service_inbound, que cria a
    -- 'inbound', o vínculo e o card (current_demanda_id) sozinho. Nada de
    -- INSERT à mão em demandas — mentiria sobre a origem da linha.
    insert into public.messages
      (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, sent_via, body, sent_at)
    values ('${MSG_COMPART_1}', '${GOV_ORG}', '${CV_COMPART_1}', '${GOV_SESSION}', '${CT_COMPART}',
            'text', 'inbound', 'received', 'ai', 'ola, vim falar do meu pedido', clock_timestamp());

    -- O canal 2 entra na MESMA demanda (cap. 5 §5.4: a demanda atravessa
    -- canais). O vínculo e o card do canal 2 são plantados aqui — é o estado
    -- que o backfill vai encontrar —, e a mensagem seguinte tem de REUSAR a
    -- demanda pelo caminho nativo (card + vínculo + revisão), não criar outra.
    insert into public.demanda_conversas (organization_id, demanda_id, conversation_id, service_revision)
    select '${GOV_ORG}', d.id, '${CV_COMPART_2}', c.service_revision
      from public.demandas d
      join public.conversations c on c.id = '${CV_COMPART_2}'
     where d.organization_id = '${GOV_ORG}' and d.contact_id = '${CT_COMPART}';
    update public.conversations cv
       set current_demanda_id = d.id
      from public.demandas d
     where cv.id = '${CV_COMPART_2}'
       and d.organization_id = '${GOV_ORG}' and d.contact_id = '${CT_COMPART}';
    insert into public.messages
      (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, sent_via, body, sent_at)
    values ('${MSG_COMPART_2}', '${GOV_ORG}', '${CV_COMPART_2}', '${SESSAO_2}', '${CT_COMPART}',
            'text', 'inbound', 'received', 'ai', 'mudei de canal, sigo no mesmo pedido', clock_timestamp());

    select public.fn_service_status('${GOV_ORG}', '${CV_CLAIMED}', 'claimed', null);
    select public.fn_service_status('${GOV_ORG}', '${CV_CLOSED}', 'closed', null);
    select public.fn_service_status('${GOV_ORG}', '${CV_RESOLVED}', 'resolved', null);
    select public.fn_service_status('${GOV_ORG}', '${CV_ARQUIVADA}', 'archived', null);
    select public.fn_service_status('${GOV_ORG}', '${CV_COMPART_1}', 'archived', null);
    select public.fn_service_status('${GOV_ORG}', '${CV_COMPART_2}', 'archived', null);
  `);
});

describe("o backfill do baseline não transforma conversa arquivada em pendência", () => {
  it("precondição: o cenário está montado como a teste supõe", () => {
    // Sem isto, fixture que não semeou nada faria as asserções seguintes
    // passarem com 0 == 0 — verde por não medir.
    for (const [ct] of CONTROLES) {
      expect(demandasAgora(ct), `controle ${ct} não pode ter demanda antes do backfill`).toBe(0);
    }
    expect(demandasAgora(CT_ARQUIVADA), "a arquivada já tinha demanda antes do backfill").toBe(0);
    // A compartilhada: UMA demanda nativa, dois vínculos, arquivada nos dois
    // canais — a foto que o backfill vai encontrar.
    expect(demandasAgora(CT_COMPART)).toBe(1);
    expect(
      Number(
        sql(`select count(*) from public.demanda_conversas dc
              join public.demandas d on d.id = dc.demanda_id
             where d.contact_id = '${CT_COMPART}';`),
      ),
    ).toBe(2);
    expect(
      sql(`select status from public.conversations where id in ('${CV_COMPART_1}', '${CV_COMPART_2}');`).split("\n"),
    ).toEqual(["archived", "archived"]);
  });

  it("1. controle: open/claimed/closed/resolved SEM demanda anterior continuam virando demanda", () => {
    const m = medir({
      depois: CONTROLES.map(
        ([ct]) => `
          select 'qtd_${ct}', count(*)::text from public.demandas where contact_id = '${ct}';
          select 'estado_${ct}', coalesce(min(estado), 'sem-demanda') from public.demandas where contact_id = '${ct}';
          select 'desfecho_${ct}', coalesce(min(desfecho::text), 'sem-demanda') from public.demandas where contact_id = '${ct}';
          select 'origem_${ct}', coalesce(min(origem), 'sem-demanda') from public.demandas where contact_id = '${ct}';
        `,
      ).join("\n"),
    });
    for (const [ct, , estado, desfecho] of CONTROLES) {
      expect(m[`qtd_${ct}`], `conversa ${estado} do controle ${ct} ficou sem demanda`).toBe("1");
      expect(m[`estado_${ct}`]).toBe(estado);
      // Desfecho NULL vira 'sem-demanda' no coalesce do select — separar
      // "não tinha desfecho" de "a contagem não achou linha nenhuma".
      expect(m[`desfecho_${ct}`]).toBe(desfecho === "" ? "sem-demanda" : desfecho);
      expect(m[`origem_${ct}`]).toBe("derivada");
    }
  });

  it("2. o guard: conversa archived SEM demanda anterior NÃO vira pendência", () => {
    const m = medir({
      depois: `
        select 'qtd', count(*)::text from public.demandas where contact_id = '${CT_ARQUIVADA}';
        select 'vinculos', count(*)::text from public.demanda_conversas dc
          join public.demandas d on d.id = dc.demanda_id
         where d.contact_id = '${CT_ARQUIVADA}';
      `,
    });
    // O caso vermelho sem a mudança: sem a guarda, o `case cv.status` do R2
    // mapeava archived para o `else 'aberta'` — a pendência que o Radar passava
    // a cobrar, com desfecho e fechada_em NULL.
    expect(
      m.qtd,
      "conversa arquivada sem demanda anterior virou demanda derivada — arquivar é operação normal, não pedido de atendimento",
    ).toBe("0");
    expect(m.vinculos).toBe("0");
  });

  it("3. reaplicar o backfill (o update.sh de todo clone) não muda nada", () => {
    const bloco = blocoDoApendice();
    const saida = sql(`
      begin;
      ${bloco}
      select 'primeira_' || x.rotulo, x.v from (
        select 'total' rotulo, count(*)::text v from public.demandas where contact_id in (${CONTATOS_CONTROLE})
        union all
        select 'arquivada', count(*)::text from public.demandas where contact_id = '${CT_ARQUIVADA}'
        union all
        select 'compart', count(*)::text from public.demandas where contact_id = '${CT_COMPART}'
      ) x;
      ${bloco}
      select 'segunda_' || x.rotulo, x.v from (
        select 'total' rotulo, count(*)::text v from public.demandas where contact_id in (${CONTATOS_CONTROLE})
        union all
        select 'arquivada', count(*)::text from public.demandas where contact_id = '${CT_ARQUIVADA}'
        union all
        select 'compart', count(*)::text from public.demandas where contact_id = '${CT_COMPART}'
      ) x;
      rollback;
    `);
    const medidas: Record<string, string> = {};
    for (const linha of saida.split("\n")) {
      const [chave, valor] = linha.split("|");
      if (chave && valor !== undefined && /^[a-z0-9_-]+$/.test(chave.trim())) {
        medidas[chave.trim()] = valor.trim();
      }
    }
    expect(medidas.primeira_total, "a primeira passada derivou as 4 demandas dos controles").toBe("4");
    expect(medidas.segunda_total, "reaplicar dobrou as demandas dos controles").toBe(medidas.primeira_total);
    expect(medidas.segunda_arquivada, "reaplicar derivou demanda para a arquivada").toBe(medidas.primeira_arquivada);
    expect(medidas.primeira_arquivada).toBe("0");
    expect(medidas.segunda_compart, "reaplicar mexeu na demanda compartilhada").toBe(medidas.primeira_compart);
    expect(medidas.primeira_compart).toBe("1");
  });

  it("4. a demanda ANTERIOR compartilhada em 2 canais + card fica intacta", () => {
    const snapshot = (prefixo: string) => `
      select '${prefixo}_qtd', count(*)::text from public.demandas where contact_id = '${CT_COMPART}';
      select '${prefixo}_id', coalesce(min(d.id::text), 'nenhuma') from public.demandas d where d.contact_id = '${CT_COMPART}';
      select '${prefixo}_estado', coalesce(min(d.estado), 'nenhuma') from public.demandas d where d.contact_id = '${CT_COMPART}';
      select '${prefixo}_proximo', coalesce(min(d.proximo_passo), 'nulo') from public.demandas d where d.contact_id = '${CT_COMPART}';
      select '${prefixo}_vinculos', count(*)::text from public.demanda_conversas dc
        join public.demandas d on d.id = dc.demanda_id
       where d.contact_id = '${CT_COMPART}';
      select '${prefixo}_card1', coalesce(max(current_demanda_id::text), 'nulo') from public.conversations where id = '${CV_COMPART_1}';
      select '${prefixo}_card2', coalesce(max(current_demanda_id::text), 'nulo') from public.conversations where id = '${CV_COMPART_2}';
      select '${prefixo}_msg1', coalesce(max(demanda_id::text), 'nulo') from public.messages where id = '${MSG_COMPART_1}';
      select '${prefixo}_msg2', coalesce(max(demanda_id::text), 'nulo') from public.messages where id = '${MSG_COMPART_2}';
    `;
    const m = medir({ antes: snapshot("antes"), depois: snapshot("depois") });
    for (const campo of ["qtd", "id", "estado", "proximo", "vinculos", "card1", "card2", "msg1", "msg2"]) {
      expect(
        m[`depois_${campo}`],
        `o backfill reescreveu '${campo}' da demanda compartilhada — o conserto é na origem, não em dado que já existia`,
      ).toBe(m[`antes_${campo}`]);
    }
    expect(m.depois_qtd).toBe("1");
    expect(m.depois_vinculos).toBe("2");
  });

  it("5. mensagem nova na arquivada reabre pelo caminho nativo e nasce no tenant certo", () => {
    const m = medir({
      depois: `
        insert into public.messages
          (id, organization_id, conversation_id, channel_session_id, contact_id,
           type, direction, status, sent_via, body, sent_at)
        values ('${MSG_REABERTA}', '${GOV_ORG}', '${CV_ARQUIVADA}', '${GOV_SESSION}', '${CT_ARQUIVADA}',
                'text', 'inbound', 'received', 'ai', 'voltei, preciso disso de novo', clock_timestamp());
        select 'status', status from public.conversations where id = '${CV_ARQUIVADA}';
        select 'org_conversa', organization_id::text from public.conversations where id = '${CV_ARQUIVADA}';
        select 'qtd', count(*)::text from public.demandas where contact_id = '${CT_ARQUIVADA}';
        select 'derivadas', count(*)::text from public.demandas where contact_id = '${CT_ARQUIVADA}' and origem = 'derivada';
        select 'inbound_id', id::text from public.demandas
         where contact_id = '${CT_ARQUIVADA}' and origem = 'inbound';
        select 'inbound_org', organization_id::text from public.demandas
         where contact_id = '${CT_ARQUIVADA}' and origem = 'inbound';
        select 'card', coalesce(max(current_demanda_id::text), 'nulo') from public.conversations where id = '${CV_ARQUIVADA}';
        select 'msg', coalesce(max(demanda_id::text), 'nulo') from public.messages where id = '${MSG_REABERTA}';
      `,
    });
    expect(m.status, "a reabertura nativa não tirou a conversa do archived").toBe("open");
    expect(m.org_conversa).toBe(GOV_ORG);
    // Com o guard, a arquivada entra na reabertura SEM passado inventado: uma
    // demanda inbound nova, no tenant certo. Sem o guard já havia a derivada do
    // backfill — e o Radar cobrava as DUAS.
    expect(m.qtd, "a reabertura criou demanda demais — o backfill já tinha inventado uma").toBe("1");
    expect(m.derivadas).toBe("0");
    expect(m.inbound_org, "a demanda da reabertura nasceu noutro tenant").toBe(GOV_ORG);
    expect(m.card, "o card da conversa não aponta para a demanda da reabertura").toBe(m.inbound_id);
    expect(m.msg, "a mensagem reaberta não foi carimbada na demanda da reabertura").toBe(m.inbound_id);
  });
});
