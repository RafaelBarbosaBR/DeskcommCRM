// @vitest-environment node
/**
 * UMA ORDEM DE LOCKS PARA MARCAR A MENSAGEM E TRAVAR O CONTATO (issue #2884).
 *
 * A `fn_mark_conversation_message` (0267) travava a CONVERSA (`for no key
 * update`) e DEPOIS o CONTATO (`update contacts set last_activity_at`). O
 * gatilho criado pela 0645 (`trg_contato_atualiza_trava_nas_conversas`) faz o
 * INVERSO: ao gravar `force_human`/`is_blocked`, trava o CONTATO (o próprio
 * UPDATE) e só então atualiza as conversas dele. As duas ordens, opostas,
 * fecham um ciclo AB-BA sobre o MESMO contato — a ingestão segura a conversa e
 * pede o contato; a passagem para humano segura o contato e pede a conversa —
 * e o Postgres derruba uma das transações com 40P01. Se a vítima é a passagem
 * para humano, A TRAVA NÃO É GRAVADA.
 *
 * Duas sessões de verdade, no Postgres efêmero do `pnpm test:db`:
 *
 *   ⭐ o ciclo — A segura o CONTATO e, no meio, troca `force_human`; B carimba
 *      uma mensagem na conversa. Com a conversa antes do contato (a forma da
 *      0267) o ciclo fecha e sai 40P01; com a ordem única (contato antes da
 *      conversa) ele não fecha e as duas transações terminam. Este caso FICA
 *      VERMELHO se a ordem voltar a ser inversa.
 *
 *   ⭐ a rajada — duas sessões concorrentes, uma alternando `force_human` no
 *      contato e outra chamando a função de carimbo na conversa dele: a
 *      contagem de 40P01 tem de ser ZERO.
 *
 *   ⭐ a criação — uma conversa NOVA nasce enquanto o contato está travado por
 *      um `force_human` em voo: o gatilho BEFORE INSERT lê o contato com
 *      `for share` (0658) e espera o commit — a criação não é vítima e o bit
 *      nasce certo.
 */
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const CONTAINER = process.env.TEST_DB_CONTAINER;
if (!CONTAINER) {
  throw new Error(
    "TEST_DB_CONTAINER not set — run this suite via `pnpm test:db` (scripts/test-db.sh)",
  );
}

const ORG = "dddddddd-0000-4000-8000-000000000001";
const SESS = "dddddddd-0000-4000-8000-000000000002";
const SESS2 = "dddddddd-0000-4000-8000-000000000003";
const C1 = "dddddddd-3333-4000-8000-000000000001";
const CONV1 = "dddddddd-4444-4000-8000-000000000001";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Rodada = { saida: string; erro: string; codigo: number | null; ms: number };

/**
 * Uma sessão psql ASSÍNCRONA de verdade (para rodar em paralelo com a do
 * teste). Sempre RESOLVE, com stdout, stderr e o código de saída, para o
 * 40P01 do deadlock ser inspecionável em vez de virar uma exceção genérica.
 *
 * `pararNoErro = false` é para a rajada: um 40P01 não pode abortar as
 * iterações seguintes (é a contagem deles que o caso mede).
 */
function psql(script: string, pararNoErro = true): Promise<Rodada> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const args = ["exec", "-i", CONTAINER as string, "psql", "-U", "postgres", "-d", "postgres", "-tA"];
    if (pararNoErro) args.push("-v", "ON_ERROR_STOP=1");
    args.push("-f", "-");
    const p = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let saida = "";
    let erro = "";
    p.stdout.on("data", (d: Buffer) => (saida += d.toString()));
    p.stderr.on("data", (d: Buffer) => (erro += d.toString()));
    p.on("close", (codigo) => resolve({ saida, erro, codigo, ms: Date.now() - t0 }));
    p.stdin.end(script);
  });
}

const contar40p01 = (...erros: string[]) =>
  (erros.join("\n").match(/deadlock detected/g) ?? []).length;

function semear() {
  sql(`
    delete from conversations where organization_id = '${ORG}';
    delete from contacts where organization_id = '${ORG}';
    delete from channel_sessions where organization_id = '${ORG}';
    delete from organizations where id = '${ORG}';
    insert into organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'ordem-de-locks-2884', 'Ordem LTDA', 'Ordem');
    insert into channel_sessions (id, organization_id, webhook_secret_encrypted, waha_session_name)
      values ('${SESS}', '${ORG}', '\\x00', 'ordem-de-locks-2884'),
             ('${SESS2}', '${ORG}', '\\x00', 'ordem-de-locks-2884-b');
    insert into contacts (id, organization_id, force_human, is_blocked)
      values ('${C1}', '${ORG}', false, false);
    insert into conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONV1}', '${ORG}', '${C1}', '${SESS}', 'open');
  `);
}

const carimbar = (conv: string) =>
  `select public.fn_mark_conversation_message('${conv}', 'inbound', 'x', now());`;

describe("uma ordem de locks para marcar a mensagem e travar o contato (issue #2884)", () => {
  it("⭐ a mensagem em voo e a passagem para humano não fecham o ciclo (a ordem inversa dá 40P01)", async () => {
    semear();

    // A segura o CONTATO com um UPDATE que NÃO mexe em force_human (para não
    // disparar o gatilho da conversa ainda) e, no meio da janela, troca
    // force_human — que é o gatilho que trava o contato e pede as conversas.
    const travando = psql(
      `begin;\n` +
        `update public.contacts set name = name where id = '${C1}';\n` +
        `select pg_sleep(1.5);\n` +
        `update public.contacts set force_human = true where id = '${C1}';\n` +
        `commit;`,
    );
    await dormir(500); // A já segura o contato

    // B carimba a mensagem na conversa. Com a ordem da 0267 trava a CONVERSA e
    // depois pede o CONTATO (que A tem) → ciclo. Com a ordem unificada pede o
    // CONTATO primeiro, no MESMO sentido de A.
    const carimbando = psql(carimbar(CONV1));
    const [ra, rb] = await Promise.all([travando, carimbando]);

    expect(
      contar40p01(ra.erro, rb.erro),
      "a mensagem em voo e a passagem para humano fecharam o ciclo AB-BA (40P01): " +
        "a função está travando a CONVERSA antes do CONTATO",
    ).toBe(0);
    expect(ra.codigo, `a passagem para humano não concluiu: ${ra.erro}`).toBe(0);
    expect(rb.codigo, `a marcação da mensagem não concluiu: ${rb.erro}`).toBe(0);
    // A trava SOBREVIVEU: o contato ficou em humano e a conversa reflete o bit.
    expect(lastLine(sql(`select force_human::text from public.contacts where id = '${C1}'`))).toBe(
      "true",
    );
    expect(
      lastLine(sql(`select contato_trava_humano::text from public.conversations where id = '${CONV1}'`)),
    ).toBe("true");
  });

  it("⭐ a rajada (carimbo × passagem para humano) roda com ZERO deadlocks", async () => {
    semear();

    const N = 150;
    const carimbos = Array.from({ length: N }, () => carimbar(CONV1)).join("\n");
    const travas = Array.from(
      { length: N },
      (_, i) => `update public.contacts set force_human = ${i % 2 === 0} where id = '${C1}';`,
    ).join("\n");

    const [rc, rt] = await Promise.all([psql(carimbos, false), psql(travas, false)]);
    const mortos = contar40p01(rc.erro, rt.erro);
    expect(
      mortos,
      `a rajada da reprodução teve ${mortos} deadlock(s) 40P01 — a ordem de locks voltou a ser inversa`,
    ).toBe(0);
    // A trava do contato e o bit da conversa seguem em sincronia depois da rajada.
    const forceHuman = lastLine(
      sql(`select force_human::text from public.contacts where id = '${C1}'`),
    );
    const bit = lastLine(
      sql(`select contato_trava_humano::text from public.conversations where id = '${CONV1}'`),
    );
    expect(bit).toBe(forceHuman);
  });

  it("⭐ a criação de conversa nova não é vítima da trava do contato", async () => {
    semear();

    // A conversa 1:1 do contato já existe; a sessão nova cria uma SEGUNDA.
    const travando = psql(
      `begin;\n` +
        `update public.contacts set force_human = true where id = '${C1}';\n` +
        `select pg_sleep(1.2);\n` +
        `commit;`,
    );
    await dormir(300);

    // O gatilho BEFORE INSERT (0658) lê o contato com `for share` e espera o
    // commit de A — o `for share` da criação e a ordem única convivem.
    const criando = await psql(
      `select public.fn_upsert_wa_conversation('${ORG}', '${C1}', '${SESS2}');`,
    );
    await travando;

    expect(criando.erro, "a criação da conversa entrou em deadlock (40P01)").not.toContain(
      "deadlock",
    );
    expect(criando.codigo, `a criação da conversa não concluiu: ${criando.erro}`).toBe(0);
    expect(
      lastLine(
        sql(
          `select contato_trava_humano::text from public.conversations
            where contact_id = '${C1}' and channel_session_id = '${SESS2}'`,
        ),
      ),
      "a conversa nasceu com a leitura ANTIGA do contato (o `for share` da 0658 caiu)",
    ).toBe("true");
  });
});
