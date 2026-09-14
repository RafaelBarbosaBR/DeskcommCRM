/**
 * AS TABELAS DO MOTOR DE RASTREAMENTO SÃO SERVER-SIDE ONLY — E ISSO SE MEDE.
 *
 * ## O que se pagaria
 *
 * `visitors`/`sessions`/`touchpoints` guardam o rastro de navegação de quem
 * visitou o site rastreado (fbclid/gclid, IP, user agent) — dado de
 * navegação de uma pessoa real. `integration_settings` guarda o token de
 * Meta/GA4/Google Ads cifrado (`secrets_encrypted`). `internal_events` é o
 * registro de conversão comercial (histórico PERMANENTE — nunca expurgado,
 * ver a migration 0242). `outbound_events`/`platform_event_logs`/
 * `meta_event_logs` são a fila de envio e o log de tentativa pra cada
 * plataforma. Nenhuma delas deveria ser alcançável pelo client de sessão: a
 * anon key vai pro browser, e quem lê estas tabelas hoje é sempre o
 * servidor com o admin client, filtrando `organization_id` à mão (a tela
 * `/app/integrations/rastreamento` e sua auditoria).
 *
 * ## Por que estas tabelas NÃO estão em `rls-isolation.test.ts`
 *
 * A ausência é deliberada, e este arquivo é a contrapartida — mesmo desenho
 * de `credencial-de-anuncios-e-server-side.test.ts` (o molde): RLS ligada,
 * zero policies, grants revogados de `anon`/`authenticated`. `authenticated`
 * não alcança nada — nem por policy, nem por ausência de uma. Rodar o molde
 * de `rls-isolation` devolveria `permission denied` em vez de `0`, e a
 * "correção" natural (criar uma policy pra contagem voltar a zero) passaria
 * a SERVIR estas tabelas pelo PostgREST. Deny-all é MAIS restritivo que
 * isolamento por tenant, não menos.
 *
 * ## Por que RLS-sem-policy não basta sozinha
 *
 * Com RLS ligada e zero policies, `anon`/`authenticated` recebem ZERO LINHA
 * — parece seguro, e um teste que só contasse linhas passaria mesmo sem o
 * revoke. Por isso aqui se mede PRIVILÉGIO (o que sobra no dia em que
 * alguém acrescentar "só uma policy de leitura") e COMPORTAMENTO
 * (`permission denied`, que distingue "a policy barrou" de "o privilégio
 * não existe").
 *
 * As 9 tabelas nasceram em 3 migrations diferentes (0233/0234/0235, motor
 * de rastreamento first-party) mais uma quarta (0242, auditoria de
 * rastreamento) — todas com a MESMA postura, medida junto porque é a mesma
 * pergunta repetida 9 vezes, não 9 perguntas diferentes.
 */
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { motivoDoErro, sql } from "./psql-transporte";

const TABELAS = [
  "visitors",
  "sessions",
  "touchpoints",
  "tracking_sites",
  "integration_settings",
  "internal_events",
  "outbound_events",
  "meta_event_logs",
  "platform_event_logs",
] as const;

function erroSob(papel: string, comando: string): string | null {
  try {
    sql(`set role ${papel};\n${comando};\nreset role;`);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

function esperaBarrado(papel: string, comando: string): void {
  const erro = erroSob(papel, comando);
  expect(erro, `\`${papel}\` executou "${comando}" SEM erro — a tabela está exposta`).not.toBeNull();
  expect(erro).toContain("permission denied");
}

function privilegiosDe(papel: string, tabela: string): string {
  return sql(`
    select coalesce(string_agg(distinct privilege_type, ',' order by privilege_type), 'NENHUM')
      from information_schema.role_table_grants
     where table_schema = 'public'
       and table_name = '${tabela}'
       and grantee = '${papel}';
  `).trim();
}

describe("a lista do `rls-isolation` e esta não se sobrepõem", () => {
  it.each(TABELAS)("`%s` NÃO está em `TABLES` do rls-isolation — e não pode entrar", (tabela) => {
    // Mesmo raciocínio de `credencial-de-anuncios-e-server-side.test.ts`:
    // acrescentar uma destas lá faria `countAs` (que roda `set role
    // authenticated`) devolver `permission denied` em vez de `0`, e a
    // "correção" óbvia — uma policy pra zerar a contagem — abriria a
    // tabela pelo PostgREST.
    const fonte = readFileSync(join(__dirname, "rls-isolation.test.ts"), "utf8");
    const lista = /export const TABLES = \[([\s\S]*?)\] as const;/.exec(fonte);
    expect(lista, "não achei `export const TABLES` no rls-isolation — a sonda cegou").not.toBeNull();

    const naLista = (lista?.[1] ?? "")
      .split("\n")
      .map((l) => /^\s*"([a-z_]+)",/.exec(l)?.[1])
      .filter((v): v is string => Boolean(v));
    expect(naLista.length, "extraí zero nomes da lista — a sonda cegou").toBeGreaterThan(5);

    expect(
      naLista.includes(tabela),
      `\`${tabela}\` entrou em TABLES do rls-isolation. Ela é deny-all (RLS ligada, ` +
        "zero policies, grants revogados): lá o caso vai falhar com `permission denied`, " +
        "e criar policy pra consertá-lo abre a tabela pelo PostgREST. A prova dela é ESTE arquivo.",
    ).toBe(false);
  });
});

describe.each(TABELAS)("o PostgREST não serve `%s`", (tabela) => {
  it("a tabela EXISTE no baseline — controle positivo da sonda", () => {
    const existe = sql(`
      select count(*) from information_schema.tables
       where table_schema = 'public' and table_name = '${tabela}';
    `).trim();
    expect(existe, `\`${tabela}\` não está no baseline — o kit self-host não a cria`).toBe("1");
  });

  it("`anon` não tem privilégio NENHUM", () => {
    expect(privilegiosDe("anon", tabela)).toBe("NENHUM");
  });

  it("`authenticated` também não tem — nenhuma tela lê isto pelo client de sessão", () => {
    expect(privilegiosDe("authenticated", tabela)).toBe("NENHUM");
  });

  it("`service_role` CONTINUA com privilégio — controle positivo do papel que usa", () => {
    const privilegios = privilegiosDe("service_role", tabela);
    expect(privilegios).toContain("SELECT");
    expect(privilegios).toContain("INSERT");
  });

  it("`anon` é BARRADO ao ler — permission denied, não zero linhas", () => {
    esperaBarrado("anon", `select id from public.${tabela}`);
  });

  it("`authenticated` é BARRADO ao ler", () => {
    esperaBarrado("authenticated", `select id from public.${tabela}`);
  });

  it("a RLS está LIGADA — o segundo degrau, para o dia em que o grant voltar", () => {
    const ligada = sql(`
      select relrowsecurity from pg_class where oid = 'public.${tabela}'::regclass;
    `).trim();
    expect(ligada, "RLS desligada: o revoke vira a única defesa").toBe("t");
  });

  it("não há policy nenhuma — servir esta tabela nunca foi a intenção", () => {
    const quantas = sql(`
      select count(*) from pg_policies
       where schemaname = 'public' and tablename = '${tabela}';
    `).trim();
    expect(
      quantas,
      "alguém criou policy: a tabela passa a ser SERVIDA pelo PostgREST, e o rastro " +
        "de navegação/credencial fica atrás de uma regra em vez de atrás da ausência de privilégio",
    ).toBe("0");
  });

  it("é tenant-aware de verdade — `organization_id` NOT NULL com FK em cascata", () => {
    const coluna = sql(`
      select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = '${tabela}'
         and column_name = 'organization_id';
    `).trim();
    expect(coluna, `\`${tabela}\` não tem organization_id`).toBe("NO");

    const cascata = sql(`
      select count(*) from information_schema.table_constraints tc
       join information_schema.referential_constraints rc
         on rc.constraint_name = tc.constraint_name
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name
       where tc.table_schema = 'public' and tc.table_name = '${tabela}'
         and tc.constraint_type = 'FOREIGN KEY'
         and kcu.column_name = 'organization_id'
         and rc.delete_rule = 'CASCADE';
    `).trim();
    expect(cascata, "a FK de organization_id não é ON DELETE CASCADE").not.toBe("0");
  });
});

describe("o segredo do provider é gravado cifrado", () => {
  // A propriedade que a tela de rastreamento promete: o token de Meta/GA4/
  // Google Ads "não volta a aparecer" depois de salvo. Os casos acima medem
  // QUEM alcança a tabela, não O QUE está dentro dela — gravar em texto
  // puro passaria por todos eles.
  it("`integration_settings.secrets_encrypted` é bytea", () => {
    const tipo = sql(`
      select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'integration_settings'
         and column_name = 'secrets_encrypted';
    `).trim();
    expect(tipo, "integration_settings.secrets_encrypted não é bytea — o token cabe em claro").toBe(
      "bytea",
    );
  });
});
