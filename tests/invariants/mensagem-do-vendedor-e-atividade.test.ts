import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";

import { sql } from "./gov-helpers";

/**
 * A FALA HUMANA DO VENDEDOR É ATIVIDADE DO NEGÓCIO (issue #2953).
 *
 * ## O defeito, medido por quem reportou
 *
 * `crm_leads.last_activity_at` só mudava por `fn_update_last_activity_at`, que é
 * o gatilho `trg_update_last_activity_at` em `crm_lead_activities`. A mensagem do
 * vendedor não cria linha lá, e `fn_mark_conversation_message` carimba apenas
 * `contacts.last_activity_at`. Então o negócio trabalhado todo dia — pelo Inbox
 * ou pelo celular — ficava com o relógio parado, e o radar de risco
 * (`lib/leads/radar-de-risco.ts`) o listava como frio.
 *
 * ## Qual negócio a fala carimba (o arremate, pedido na revisão do PR)
 *
 * A primeira versão carimbava TODOS os abertos do contato com o MESMO
 * `new.created_at` — e isso FABRICAVA um empate onde podia não haver nenhum. O
 * roteador (`resolveActiveLeadForContact`) decide por
 * `coalesce(last_activity_at, created_at)` decrescente e trata empate no topo
 * como ambíguo de propósito. Depois de UMA fala, dois abertos que o roteador
 * compara entre si deixavam de ter vencedor.
 *
 * Agora o gatilho carimba SÓ o topo daquela mesma ordenação, e NADA quando o
 * topo está empatado. Os casos (12) e (13) medem exatamente isso, com a MESMA
 * função que o produto usa para rotear — não uma reimplementação da chave. O
 * caso (14) mede a PRECISÃO: o roteador compara em milissegundos, e dois abertos
 * separados por microssegundos são empate para ele — o gatilho também tem de
 * vê-los assim.
 *
 * ## Este arquivo mede COMPORTAMENTO, não a cláusula `when` do gatilho
 *
 * Cada caso insere UMA mensagem de verdade em `public.messages` e olha o relógio
 * dos negócios antes e depois. Conferir a lista de `sent_via` contra si mesma
 * passaria com o `in` virado, com o `where` do `update` sem filtro de status e
 * com o `coalesce(..., '-infinity') < new.created_at` ausente — os três defeitos
 * que este arquivo existe para pegar.
 *
 * ## A bancada, e por que SEIS negócios
 *
 * Da fala do vendedor sobre o contato dependem quatro decisões do gatilho, e cada
 * negócio abaixo isola uma:
 *
 *   `abertoA`              MESMO contato, MESMA organização, ABERTO, e o TOPO da
 *                          ordenação do roteador — é ele (só ele) que tem de andar.
 *   `abertoB`              MESMO contato, MESMA organização, ABERTO, UM DIA mais
 *                          velho que `abertoA` — tem de ficar INTOCADO. É o par que
 *                          mede "só o topo anda": com os dois no mesmo instante o
 *                          caso passaria sem medir ordem nenhuma.
 *   `ganho`, `perdido`     mesmo contato, MESMA organização, FECHADOS — fechar é o
 *                          fim do relógio, e o radar só olha negócio aberto.
 *   `deOutroContato`       MESMA organização, contato DIFERENTE, aberto — a
 *                          mensagem é sobre um contato, não sobre a empresa.
 *   `deOutraOrg`           OUTRA organização, aberto — o isolamento por tenant.
 *
 * ## Nada fica no banco
 *
 * Cada caso vive inteiro dentro de uma transação REVERTIDA (mesmo desenho de
 * `relogio-do-silencio.test.ts`, com o motivo lá medido: limpeza em `afterAll` de
 * tabela compartilhada torna o VIZINHO intermitente, e intermitente é pior que
 * vermelho porque some quando alguém vai investigar).
 */

const DIAS_TRINTA = "now() - interval '30 days'";

/** `abertoB` nasce UM DIA mais velho que `abertoA`: o topo do contato é ÚNICO. */
function umDiaMaisVelho(relogio: string): string {
  return `(${relogio}) - interval '1 day'`;
}

/** Os seis negócios da bancada, na ordem em que são lidos. */
const ROTULOS = [
  "abertoA",
  "abertoB",
  "ganho",
  "perdido",
  "deOutroContato",
  "deOutraOrg",
] as const;

type Rotulo = (typeof ROTULOS)[number];
type Leitura = { antes: string; depois: string };
/** O trecho de relógio: quanto andou cada negócio, antes e depois da fala. */
type Momento = "antes" | "depois";

interface Mensagem {
  /** `messages.direction`. Default `outbound`: quem fala é o vendedor. */
  direction?: "outbound" | "inbound";
  /** `messages.sent_via`. Default `user`: o Inbox do CRM. */
  sentVia?: string;
  /** `messages.type`. Default `text`. */
  type?: string;
  /** Literal jsonb (sem cast) para `messages.metadata`. Default `'{}'`. */
  metadata?: string;
  /** Expressão SQL de `messages.created_at`. Default `now()`. */
  createdAt?: string;
  /**
   * Quando `true`, a LINHA de `messages` nasce na organização B (a "outra" da
   * bancada) apontando para o contato e a conversa da organização A — uma linha
   * incoerente de propósito, que é a única forma de medir o filtro de
   * organização separado do filtro de contato.
   */
  organizacaoDeOutra?: boolean;
}

/** Os ids sorteados da bancada. Viajam para o Node, então nada vem de `returning`. */
interface Ids {
  org: string;
  outraOrg: string;
  pipeline: string;
  outraPipeline: string;
  etapa: string;
  outraEtapa: string;
  sessao: string;
  contato: string;
  outroContato: string;
  contatoDeOutraOrg: string;
  conversa: string;
  abertoA: string;
  abertoB: string;
  ganho: string;
  perdido: string;
  deOutroContato: string;
  deOutraOrg: string;
}

function sortear(): Ids {
  return {
    org: randomUUID(),
    outraOrg: randomUUID(),
    pipeline: randomUUID(),
    outraPipeline: randomUUID(),
    etapa: randomUUID(),
    outraEtapa: randomUUID(),
    sessao: randomUUID(),
    contato: randomUUID(),
    outroContato: randomUUID(),
    contatoDeOutraOrg: randomUUID(),
    conversa: randomUUID(),
    abertoA: randomUUID(),
    abertoB: randomUUID(),
    ganho: randomUUID(),
    perdido: randomUUID(),
    deOutroContato: randomUUID(),
    deOutraOrg: randomUUID(),
  };
}

/**
 * Os INSERTs da bancada. `relogioA` e `relogioB` são expressões SQL e podem ser
 * IGUAIS (o caso (13), de propósito) ou diferentes (o default, e o caso (12)).
 */
function bancadaSQL(b: Ids, relogioA: string, relogioB: string): string {
  return `
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${b.org}', 'inv-2953-a', 'Inv 2953 A', 'Inv 2953 A'),
             ('${b.outraOrg}', 'inv-2953-b', 'Inv 2953 B', 'Inv 2953 B');
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${b.pipeline}', '${b.org}', 'Inv 2953 A', 'inv-2953-a'),
             ('${b.outraPipeline}', '${b.outraOrg}', 'Inv 2953 B', 'inv-2953-b');
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${b.etapa}', '${b.org}', '${b.pipeline}', 'Novo', 'novo', 1000),
             ('${b.outraEtapa}', '${b.outraOrg}', '${b.outraPipeline}', 'Novo', 'novo', 1000);
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${b.sessao}', '${b.org}', 'inv-2953', '\\x00'::bytea);
    insert into public.contacts (id, organization_id, display_name)
      values ('${b.contato}', '${b.org}', 'Vendedor 2953'),
             ('${b.outroContato}', '${b.org}', 'Outro contato 2953'),
             ('${b.contatoDeOutraOrg}', '${b.outraOrg}', 'Contato da outra organização');
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${b.conversa}', '${b.org}', '${b.contato}', '${b.sessao}', 'open');
    insert into public.crm_leads
      (id, organization_id, pipeline_id, stage_id, contact_id, title, status, lost_reason, closed_at, last_activity_at, position_in_stage)
      values
        ('${b.abertoA}', '${b.org}', '${b.pipeline}', '${b.etapa}', '${b.contato}',
         'Aberto A', 'open', null, null, ${relogioA}, 1000),
        ('${b.abertoB}', '${b.org}', '${b.pipeline}', '${b.etapa}', '${b.contato}',
         'Aberto B', 'open', null, null, ${relogioB}, 2000),
        ('${b.ganho}', '${b.org}', '${b.pipeline}', '${b.etapa}', '${b.contato}',
         'Ganho', 'won', null, now(), ${relogioA}, 3000),
        ('${b.perdido}', '${b.org}', '${b.pipeline}', '${b.etapa}', '${b.contato}',
         'Perdido', 'lost', 'no_response', now(), ${relogioA}, 4000),
        ('${b.deOutroContato}', '${b.org}', '${b.pipeline}', '${b.etapa}', '${b.outroContato}',
         'Aberto de outro contato', 'open', null, null, ${relogioA}, 5000),
        ('${b.deOutraOrg}', '${b.outraOrg}', '${b.outraPipeline}', '${b.outraEtapa}', '${b.contatoDeOutraOrg}',
         'Aberto na outra organização', 'open', null, null, ${relogioA}, 6000);`;
}

/** A fala do vendedor — a mensagem que dispara o gatilho (ou não, pelo `when`). */
function mensagemSQL(b: Ids, m: Mensagem): string {
  return `
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, created_at, metadata)
    values ('${m.organizacaoDeOutra ? b.outraOrg : b.org}', '${b.conversa}', '${b.sessao}', '${b.contato}',
            '${m.type ?? "text"}', '${m.direction ?? "outbound"}', 'sent', '${m.sentVia ?? "user"}',
            ${m.createdAt ?? "now()"}, ${m.metadata ?? "'{}'"}::jsonb);`;
}

interface BancadaMedida {
  /** O relógio dos seis negócios, como texto, antes e depois da fala. */
  relogios: Map<Rotulo, Leitura>;
  /** Os negócios ABERTOS do contato, como o roteador os enxerga. */
  candidatos: Record<Momento, LeadCandidate[]>;
  ids: Ids;
}

/**
 * Roda a bancada inteira numa transação revertida e devolve, das DUAS leituras:
 *
 *   - o relógio dos seis negócios (o que os casos de comportamento conferem);
 *   - os negócios abertos DO CONTATO no formato `LeadCandidate`, para que os
 *     casos (12) e (13) chamem a MESMA `resolveActiveLeadForContact` do produto.
 *
 * `relogioDeB` só existe para o caso (13) nascer empatado; nos demais `abertoB`
 * fica um dia atrás de `abertoA`, que é o que dá ao contato um TOPO ÚNICO.
 */
function medirComRoteador(
  m: Mensagem,
  opts: { relogio?: string; relogioDeB?: string } = {},
): BancadaMedida {
  const b = sortear();
  const relogioA = opts.relogio ?? DIAS_TRINTA;
  const relogioB = opts.relogioDeB ?? umDiaMaisVelho(relogioA);

  // O mapa rótulo → id viaja para dentro do SQL: a leitura sai ordenada por
  // rótulo, então `antes` e `depois` vêm na MESMA ordem sem o Node adivinhar.
  const mapa = ROTULOS.map((r) => `('${r}', '${b[r]}'::uuid)`).join(",\n        ");

  // Os dois seletores saem de UMA chamada só, com prefixo dizendo o que cada
  // linha é. O relógio vem como TEXTO (a igualdade de duas leituras é o que os
  // casos de comportamento medem); o candidato vem como epoch de ms, e é o Node
  // quem devolve o ISO — assim a MESMA `new Date()` do roteador lê os dois lados.
  const leitura = (momento: string): string => `
    select 'relogio|${momento}|' || v.rotulo || '|' || coalesce(l.last_activity_at::text, 'NULO')
      from (values
        ${mapa}
      ) as v(rotulo, id)
      join public.crm_leads l on l.id = v.id
     order by v.rotulo;

    select 'cand|${momento}|' || l.id || '|' || l.organization_id || '|' || l.pipeline_id || '|' || l.status
           || '|' || coalesce(extract(epoch from l.last_activity_at)::text, 'NULO')
           || '|' || extract(epoch from l.created_at)::text
      from public.crm_leads l
     where l.contact_id = '${b.contato}'
       and l.status = 'open'
     order by l.id;`;

  const saida = sql(`
    begin;

    ${bancadaSQL(b, relogioA, relogioB)}

    ${leitura("antes")}

    ${mensagemSQL(b, m)}

    ${leitura("depois")}

    rollback;
  `);

  const relogios = new Map<Rotulo, Leitura>();
  const candidatos: Record<Momento, LeadCandidate[]> = { antes: [], depois: [] };

  for (const linha of saida.split("\n")) {
    const campos = linha.split("|");
    const tipo = campos[0];
    const momento = campos[1];
    if (momento !== "antes" && momento !== "depois") continue;

    if (tipo === "relogio") {
      const rotulo = campos[2] as Rotulo;
      const atual = relogios.get(rotulo) ?? { antes: "", depois: "" };
      atual[momento] = campos[3] ?? "";
      relogios.set(rotulo, atual);
      continue;
    }

    if (tipo === "cand") {
      candidatos[momento].push({
        id: campos[2]!,
        organization_id: campos[3]!,
        pipeline_id: campos[4]!,
        status: campos[5] as LeadCandidate["status"],
        last_activity_at: campos[6] === "NULO" ? null : new Date(Number(campos[6]) * 1000).toISOString(),
        created_at: new Date(Number(campos[7]) * 1000).toISOString(),
      });
    }
  }

  return { relogios, candidatos, ids: b };
}

/** A bancada dos casos de comportamento: só o relógio interessa. */
function medir(m: Mensagem, relogio: string = DIAS_TRINTA): Map<Rotulo, Leitura> {
  return medirComRoteador(m, { relogio }).relogios;
}

/**
 * A régua de TODOS os casos, e é por isso que ela é uma só: em nenhum cenário um
 * negócio fechado, o de outro contato ou o de outra organização pode andar — nem
 * o OUTRO aberto do contato, que o roteador não escolheria. Um caso que só
 * olhasse o topo deixaria passar um `update` sem filtro.
 */
function conferir(leitura: Map<Rotulo, Leitura>, moveram: readonly Rotulo[]): void {
  expect(
    [...leitura.keys()].sort(),
    "a bancada não foi lida inteira — algum negócio não existe, e o caso abaixo passaria por vacuidade",
  ).toEqual([...ROTULOS].sort());

  for (const rotulo of ROTULOS) {
    const { antes, depois } = leitura.get(rotulo)!;
    // As duas leituras têm de EXISTIR: comparar "" com "" passaria em qualquer
    // cenário, inclusive com a bancada falhando calada.
    expect(antes, `${rotulo} sem leitura de partida`).not.toBe("");
    expect(antes, `${rotulo} nasceu sem relógio — a bancada não montou o caso`).not.toBe("NULO");
    expect(depois, `${rotulo} sem leitura final`).not.toBe("");
    if (moveram.includes(rotulo)) {
      expect(
        depois,
        `${rotulo} NÃO andou com a fala do vendedor — é o defeito da issue #2953: o radar de risco segue marcando negócio trabalhado como frio`,
      ).not.toBe(antes);
    } else {
      expect(depois, `${rotulo} andou e não podia`).toBe(antes);
    }
  }
}

/**
 * O negócio que a fala do vendedor sobre o contato tem de mover: SÓ o topo da
 * ordenação do roteador — `coalesce(last_activity_at, created_at)` decrescente.
 * `abertoB` fica de fora de propósito: é o par que mede "só o topo anda".
 */
const O_TOPO_ABERTO_DO_CONTATO = ["abertoA"] as const;

describe("0686 · a mensagem do vendedor é atividade do negócio", () => {
  it("(1) fala pelo Inbox do CRM (sent_via='user'): carimba o TOPO aberto do contato, e só ele", () => {
    conferir(medir({ sentVia: "user", direction: "outbound" }), O_TOPO_ABERTO_DO_CONTATO);
  });

  it("(2) fala pelo aparelho conectado (sent_via='external_device'): carimba o topo aberto do contato", () => {
    conferir(medir({ sentVia: "external_device", direction: "outbound" }), O_TOPO_ABERTO_DO_CONTATO);
  });

  it("(3) fala pelo vocabulário antigo de envio do CRM (sent_via='crm'): carimba o topo aberto do contato", () => {
    conferir(medir({ sentVia: "crm", direction: "outbound" }), O_TOPO_ABERTO_DO_CONTATO);
  });

  it("(4) mensagem da IA (sent_via='ai') não carimba: o relógio do negócio é de GENTE", () => {
    conferir(medir({ sentVia: "ai", direction: "outbound" }), []);
  });

  it("(5) mensagem da automação (sent_via='automation') não carimba", () => {
    conferir(medir({ sentVia: "automation", direction: "outbound" }), []);
  });

  it("(6) reação de emoji (type='reaction') não é fala", () => {
    conferir(medir({ sentVia: "external_device", type: "reaction" }), []);
  });

  it("(7) aviso de sistema (sent_via='system', type='system') não é fala", () => {
    conferir(medir({ sentVia: "system", type: "system" }), []);
  });

  it("(8) histórico importado (metadata.historico_importado='true') não é atendimento de agora", () => {
    conferir(
      medir({ sentVia: "external_device", metadata: `'{"historico_importado": "true"}'` }),
      [],
    );
  });

  it("(8b) histórico importado também na forma booleana (metadata.historico_importado=true)", () => {
    conferir(medir({ sentVia: "external_device", metadata: `'{"historico_importado": true}'` }), []);
  });

  it("(9) a fala do CLIENTE (inbound) não é trabalho do vendedor: quem espera resposta é o risco que o radar deve mostrar", () => {
    conferir(medir({ sentVia: "external_device", direction: "inbound" }), []);
  });

  it("(10) envio de OUTRA organização não atravessa o tenant, mesmo apontando para o MESMO contato", () => {
    // Bancada adversarial: a linha de `messages` nasce na organização B e aponta
    // para o CONTATO e a conversa da organização A (as FKs permitem; nenhuma
    // constraint promete coerência de tenant na linha). O contato casa, a
    // organização não: se o `update` do gatilho perdesse
    // `l.organization_id = new.organization_id`, o negócio de A seria carimbado
    // por um envio de B — a escrita cross-tenant que este repo persegue.
    const outra = medir({ sentVia: "user", direction: "outbound", organizacaoDeOutra: true });
    conferir(outra, []);

    // A mesma bancada com o envio de A continua carimbando: a sonda acima é
    // viva, o que ela mede não é "o gatilho não funciona neste arquivo".
    const mesma = medir({ sentVia: "user", direction: "outbound" });
    conferir(mesma, O_TOPO_ABERTO_DO_CONTATO);
  });

  it("(11) a data NUNCA anda para trás: negócio com relógio mais NOVO que a mensagem fica intocado", () => {
    conferir(
      medir(
        { sentVia: "user", direction: "outbound", createdAt: "now() - interval '10 days'" },
        "now() - interval '1 hour'",
      ),
      [],
    );
  });

  it("(11b) e o mesmo envio humano carimba o negócio de relógio VELHO — a régua do caso (11) tem os dois lados", () => {
    conferir(
      medir(
        { sentVia: "user", direction: "outbound", createdAt: "now() - interval '10 days'" },
        "now() - interval '30 days'",
      ),
      O_TOPO_ABERTO_DO_CONTATO,
    );
  });

  it("(12) dois abertos de relógios DIFERENTES: a fala carimba SÓ o topo e o roteador continua no MESMO negócio", () => {
    const medida = medirComRoteador({ sentVia: "user", direction: "outbound" });

    // CONTROLE VIVO da bancada: os dois abertos PARTEM de relógios diferentes, e
    // por isso o roteador JÁ tem um topo único antes de a fala acontecer. Sem
    // este controle, uma bancada nascida empatada passaria sem medir ordem nenhuma.
    expect(
      resolveActiveLeadForContact(medida.candidatos.antes),
      "a bancada nasceu empatada — sem topo único não há ordem a preservar",
    ).toEqual({ routed: true, leadId: medida.ids.abertoA });

    // O EFEITO QUE O MANTENEDOR MEDIU: sob a versão que carimbava todos os
    // abertos, os dois ficavam com o MESMO instante e o roteador caía em
    // `ambiguous_open_leads` — os treze pontos que usam o roteador deixavam de
    // achar o negócio da pessoa depois de UMA fala.
    expect(
      resolveActiveLeadForContact(medida.candidatos.depois),
      "a fala do vendedor derrubou o roteador para `ambiguous_open_leads` — a ordem entre os abertos não se preservou",
    ).toEqual({ routed: true, leadId: medida.ids.abertoA });

    // E a ORDEM se preserva negócio a negócio: só o topo andou; o outro aberto do
    // contato — que o roteador não escolheria — fica exatamente onde estava.
    expect(medida.relogios.get("abertoA")!.depois).not.toBe(medida.relogios.get("abertoA")!.antes);
    expect(
      medida.relogios.get("abertoB")!.depois,
      "o TOPO era o `abertoA` e o `abertoB` andou junto — o gatilho voltou a carimbar todos os abertos",
    ).toBe(medida.relogios.get("abertoB")!.antes);
  });

  it("(13) dois abertos EMPATADOS: a fala não carimba NADA e a ambiguidade segue exatamente como estava", () => {
    const medida = medirComRoteador(
      { sentVia: "user", direction: "outbound" },
      { relogioDeB: DIAS_TRINTA }, // MESMO instante do `abertoA`: o contato nasce empatado
    );

    // CONTROLE: os dois abertos partem do MESMO instante, e o roteador já responde
    // ambíguo — é o cenário do caso.
    const ambiguidade = {
      routed: false,
      reason: "ambiguous_open_leads",
      candidateIds: medida.candidatos.antes.map((c) => c.id),
    };
    expect(resolveActiveLeadForContact(medida.candidatos.antes)).toEqual(ambiguidade);

    // NADA foi carimbado: os dois relógios ficam exatamente como estavam. Empate
    // era ambíguo antes desta mudança e continua ambíguo — o gatilho não arbitra
    // o que a regra §3.2 decidiu não arbitrar.
    expect(
      medida.relogios.get("abertoA")!.depois,
      "o `abertoA` andou num contato com o topo EMPATADO — o gatilho arbitrou uma ambiguidade",
    ).toBe(medida.relogios.get("abertoA")!.antes);
    expect(
      medida.relogios.get("abertoB")!.depois,
      "o `abertoB` andou num contato com o topo EMPATADO — o gatilho arbitrou uma ambiguidade",
    ).toBe(medida.relogios.get("abertoB")!.antes);

    // ...e a ambiguidade segue EXATAMENTE como estava: mesmo desfecho, mesmos candidatos.
    expect(resolveActiveLeadForContact(medida.candidatos.depois)).toEqual(ambiguidade);
  });

  it("(14) dois abertos separados por MICROssegundos no mesmo milissegundo: empate para o roteador, e a fala não carimba NADA", () => {
    // O roteador compara em MILIssegundos (`new Date(iso).getTime()`); o Postgres
    // guarda MICROssegundos. Os dois relógios caem no MESMO milissegundo, 500 µs
    // um do outro. As frações .250 e .750 ficam longe da borda do ms de propósito:
    // a leitura do candidato passa por `extract(epoch)` em ponto flutuante, e uma
    // fração .000 poderia virar .999 do milissegundo anterior.
    const base = "date_trunc('milliseconds', now() - interval '30 days') + interval '250 microseconds'";
    const medida = medirComRoteador(
      { sentVia: "user", direction: "outbound" },
      { relogio: `(${base}) + interval '500 microseconds'`, relogioDeB: base },
    );

    // CONTROLE da bancada, nos dois lados: para o Postgres os relógios DIFEREM...
    expect(
      medida.relogios.get("abertoA")!.antes,
      "a bancada nasceu com os dois relógios iguais no microssegundo — o caso não mediria a precisão",
    ).not.toBe(medida.relogios.get("abertoB")!.antes);

    // ...e para o roteador são EMPATE.
    const ambiguidade = {
      routed: false,
      reason: "ambiguous_open_leads",
      candidateIds: medida.candidatos.antes.map((c) => c.id),
    };
    expect(resolveActiveLeadForContact(medida.candidatos.antes)).toEqual(ambiguidade);

    // NADA foi carimbado: comparar no microssegundo veria um topo único e o
    // carimbaria, criando o vencedor que o roteador recusa escolher.
    expect(
      medida.relogios.get("abertoA")!.depois,
      "o `abertoA` andou num empate de milissegundo — o gatilho comparou em microssegundos e arbitrou a ambiguidade do roteador",
    ).toBe(medida.relogios.get("abertoA")!.antes);
    expect(medida.relogios.get("abertoB")!.depois).toBe(medida.relogios.get("abertoB")!.antes);

    expect(resolveActiveLeadForContact(medida.candidatos.depois)).toEqual(ambiguidade);
  });
});
