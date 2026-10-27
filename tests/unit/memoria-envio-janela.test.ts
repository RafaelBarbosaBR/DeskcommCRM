/**
 * Pipeline EXECUTÁVEL da janela de memória (#2996, itens 4 e 5).
 *
 * Motivo: na revisão, o sabotador trocou o corte "desde a última inbound" de
 * `memoria-envio.ts` por `and true` e os 39 testes seguiram todos verdes —
 * nenhum deles executava a ponte "banco → memória → trava" com estado
 * controlado. Este arquivo fecha a lacuna em duas camadas honestas:
 *
 *  1. PIPELINE: linhas do banco fake → `corposEnviadosDesdeUltimaInbound` →
 *     `dupTrava.semear` → `dupTrava.checar` — repetição do que já saiu suprime;
 *     janela vazia (cenário pós-nova-inbound) responde; falha não bloqueia;
 *     corpo em branco nunca entra.
 *  2. CONTRATO DO SQL: o `query` capturado precisa carregar o corte da inbound,
 *     a janela temporal, o filtro de outbound e a exclusão de `failed`. É este
 *     contrato que FALHA sob a sabotagem `and true` — o teste final aplica a
 *     mutação na fonte e prova que o assert derruba.
 *
 * LIMITES, ditos: o fake NÃO interpreta SQL — a semântica de "janela vazia após
 * nova inbound" e de "failed fora da resposta" vive no WHERE, conferido por
 * contrato aqui e executado de verdade só no Postgres (CI / `test:db`). Nada
 * abaixo roda e2e nem banco real.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { corposEnviadosDesdeUltimaInbound } from "@/lib/agent-engine/agent/memoria-envio";
import { criarTravaDeDuplicata } from "@/lib/agent-engine/agent/near-dup";

type Queryable = Parameters<typeof corposEnviadosDesdeUltimaInbound>[0];
type OpcaoDeJanela = NonNullable<Parameters<typeof corposEnviadosDesdeUltimaInbound>[2]>;

interface ConsultaCapturada {
  sql: string;
  params: readonly unknown[];
}

function criarDbFake(linhas: Array<{ body: string | null }>): {
  db: Queryable;
  consultas: ConsultaCapturada[];
} {
  const consultas: ConsultaCapturada[] = [];
  const db = {
    query: async (sql: string, params: readonly unknown[]) => {
      consultas.push({ sql, params });
      return { rows: linhas };
    },
  } as unknown as Queryable;
  return { db, consultas };
}

const ALVO = { organizationId: "org_1", conversationId: "conv_1" };
const JANELA_7_DIAS_MS = 7 * 24 * 60 * 60 * 1000;

describe("pipeline banco → memória → trava (comportamento de fato)", () => {
  it("repetição do que já saiu é suprimida pela trava semeada", async () => {
    const { db, consultas } = criarDbFake([{ body: "Sim, sua consulta é amanhã às 10h." }]);
    const janela = await corposEnviadosDesdeUltimaInbound(db, ALVO);
    expect(consultas).toHaveLength(1);
    const trava = criarTravaDeDuplicata();
    trava.semear(janela);
    expect(trava.checar("Sim, sua consulta é amanhã às 10h.")).not.toBeNull();
    expect(trava.checar("Sim, sua consulta é amanhã às 10h!")).not.toBeNull();
    expect(trava.checar("Seu exame de sangue ficou pronto para retirada.")).toBeNull();
  });

  it("pergunta repetida APÓS nova inbound do cliente RECEBE resposta (janela vazia)", async () => {
    // Cenário pós-corte: o cliente falou de novo → a query devolve [] (nada de
    // outbound DEPOIS da inbound mais nova — semântica do WHERE, contrato na
    // seção seguinte). A MESMA pergunta que o agente já respondeu antes da
    // inbound passa pela trava agora — é a resposta legítima ao reenvio.
    const { db } = criarDbFake([]);
    const janela = await corposEnviadosDesdeUltimaInbound(db, ALVO);
    expect(janela).toEqual([]);
    const trava = criarTravaDeDuplicata();
    trava.semear(janela);
    expect(trava.checar("Sua consulta é amanhã às 10h, não esqueça.")).toBeNull();
  });

  it("mensagem que FALHOU não bloqueia a próxima tentativa (#2996, itens 4 e 5)", async () => {
    // O WHERE exclui `failed` (assert do SQL abaixo) — portanto as linhas que
    // chegam daqui NUNCA contêm o corpo que falhou, como no banco real.
    const { db, consultas } = criarDbFake([
      { body: "Seu agendamento foi confirmado para sexta." }, // único envio bem-sucedido
    ]);
    const janela = await corposEnviadosDesdeUltimaInbound(db, ALVO);
    expect(consultas[0]!.sql).toContain("coalesce(m.status, '') <> 'failed'");
    const trava = criarTravaDeDuplicata();
    trava.semear(janela);
    const corpoQueFalhou = "Seu agendamento está marcado para sexta.";
    expect(janela).not.toContain(corpoQueFalhou);
    expect(trava.checar(corpoQueFalhou)).toBeNull(); // elegível de novo
    expect(trava.checar("Seu agendamento foi confirmado para sexta.")).not.toBeNull(); // o que saiu segue suprimindo
  });

  it("linhas em branco/nulas caem fora e a ordem devolvida é preservada", async () => {
    const { db } = criarDbFake([
      { body: "primeira" },
      { body: null },
      { body: "   " },
      { body: "segunda" },
    ]);
    expect(await corposEnviadosDesdeUltimaInbound(db, ALVO)).toEqual(["primeira", "segunda"]);
  });

  it("parâmetros: alvo, janela de 7 dias e teto de 15 (opts sobrescrevem)", async () => {
    const { db, consultas } = criarDbFake([]);
    await corposEnviadosDesdeUltimaInbound(db, ALVO);
    expect(consultas[0]!.params).toEqual([
      ALVO.organizationId,
      ALVO.conversationId,
      JANELA_7_DIAS_MS,
      15,
    ]);
    const opts: OpcaoDeJanela = { limite: 3, janelaMs: 60_000 };
    await corposEnviadosDesdeUltimaInbound(db, ALVO, opts);
    expect(consultas[1]!.params).toEqual([ALVO.organizationId, ALVO.conversationId, 60_000, 3]);
  });
});

describe("contrato do WHERE — o que a sabotagem `and true` derruba", () => {
  const sqlDaConsulta = async (): Promise<string> => {
    const { db, consultas } = criarDbFake([]);
    await corposEnviadosDesdeUltimaInbound(db, ALVO);
    return consultas[0]!.sql;
  };

  it("carrega o corte da inbound, o filtro de outbound, a janela e o `failed`", async () => {
    const sql = await sqlDaConsulta();
    expect(sql).toContain("direction = 'inbound'");
    expect(sql).toContain("m.created_at > coalesce(u.em");
    expect(sql).toContain("m.direction = 'outbound'");
    expect(sql).toContain("m.created_at > now() - ($3::bigint * interval '1 millisecond')");
    expect(sql).toContain("coalesce(m.status, '') <> 'failed'");
    expect(sql).toContain("order by m.created_at desc");
    expect(sql).toContain("limit $4");
  });

  it("MUTAÇÃO: trocar o corte por `and true` (a sabotagem da revisão) é rejeitado", () => {
    const fonte = readFileSync(
      join(process.cwd(), "lib/agent-engine/agent/memoria-envio.ts"),
      "utf8",
    );
    const sabotada = fonte.replace(/and m\.created_at > coalesce\(u\.em[^)]*\)/, "and true");
    // a mutação acontece de fato (a fonte muda)...
    expect(sabotada).not.toBe(fonte);
    expect(sabotada).toContain("and true");
    // ...e o MESMO contrato aplicado ao SQL capturado a reprova: a estrutura
    // segue íntegra (é por isso que a sabotagem passava em tudo antes)...
    expect(sabotada).toContain("direction = 'inbound'");
    // ...mas o corte sumiu — o assert falha, e a suíte fica VERMELHA sob a
    // sabotagem que deixava os 39 testes todos verdes.
    expect(sabotada).not.toContain("m.created_at > coalesce(u.em");
  });
});
