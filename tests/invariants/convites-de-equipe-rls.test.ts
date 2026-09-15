import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * `team_invites` NÃO VAZA ENTRE ORGANIZAÇÕES — E TAMBÉM NÃO VAZA PARA DENTRO
 * DA PRÓPRIA ORGANIZAÇÃO PARA QUEM NÃO ADMINISTRA GENTE.
 *
 * Arquivo próprio, não uma linha em `rls-isolation.test.ts` (migration 0245):
 * aquele molde semeia um usuário `agent` por organização e exige controle
 * positivo — mas a policy de leitura de `team_invites` exige `manager`+, e a
 * de escrita `admin`+. Um `agent` nunca leria a própria org ali; o controle
 * positivo falharia por ACERTO, não por RLS frouxa (mesmo raciocínio já
 * documentado em `historico-de-captacao-rls.test.ts` e citado em
 * `rls-completude-varredura.test.ts`/PROVA_PROPRIA).
 *
 * Conectar como `postgres` mediria NADA (rolbypassrls = t). Aqui é `set role
 * authenticated` + `request.jwt.claims`, o mesmo caminho que o PostgREST usa.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

function countAs(userId: string, countQuery: string): number {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${countQuery}
  `);
  const lines = out.split("\n");
  const last = lines[lines.length - 1];
  if (last === undefined || !/^\d+$/.test(last)) {
    throw new Error(`saída inesperada do psql: ${out}`);
  }
  return Number(last);
}

// UUIDs próprios, sem disputar linha com os outros arquivos de invariante.
const ORG_A = "eeeeeeee-0000-4000-8000-0000000000c1";
const ORG_B = "eeeeeeee-0000-4000-8000-0000000000c2";
const ADMIN_A = "eeeeeeee-1111-4000-8000-0000000000c1";
const MANAGER_A = "eeeeeeee-1111-4000-8000-0000000000c2";
const AGENT_A = "eeeeeeee-1111-4000-8000-0000000000c3";
const ADMIN_B = "eeeeeeee-1111-4000-8000-0000000000c4";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ADMIN_A}',   'convites-admin-a@invariant.test'),
      ('${MANAGER_A}', 'convites-mgr-a@invariant.test'),
      ('${AGENT_A}',   'convites-agent-a@invariant.test'),
      ('${ADMIN_B}',   'convites-admin-b@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'convites-inv-a', 'Convites Invariant A', 'Convites A'),
      ('${ORG_B}', 'convites-inv-b', 'Convites Invariant B', 'Convites B')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ADMIN_A}',   '${ORG_A}', 'admin',   now()),
      ('${MANAGER_A}', '${ORG_A}', 'manager', now()),
      ('${AGENT_A}',   '${ORG_A}', 'agent',   now()),
      ('${ADMIN_B}',   '${ORG_B}', 'admin',   now())
      on conflict do nothing;

    -- Um convite pendente por organização, com um e-mail sintético.
    insert into public.team_invites (id, organization_id, email, role, expires_at, invited_by)
    select gen_random_uuid(), v.org, 'convidado-' || v.org::text || '@invariant.test', 'agent',
           now() + interval '24 hours', v.admin
      from (values ('${ORG_A}'::uuid, '${ADMIN_A}'::uuid), ('${ORG_B}'::uuid, '${ADMIN_B}'::uuid)) as v(org, admin)
     where not exists (
       select 1 from public.team_invites t where t.organization_id = v.org
     );
  `);
});

describe("team_invites — isolamento e gate de papel", () => {
  it("o admin da org A lê os convites da PRÓPRIA org (controle positivo)", () => {
    const proprios = countAs(
      ADMIN_A,
      `select count(*) from public.team_invites where organization_id = '${ORG_A}';`,
    );
    expect(proprios).toBeGreaterThan(0);
  });

  it("o manager da org A também lê (a policy de leitura é manager+, não só admin)", () => {
    const proprios = countAs(
      MANAGER_A,
      `select count(*) from public.team_invites where organization_id = '${ORG_A}';`,
    );
    expect(proprios).toBeGreaterThan(0);
  });

  it("o admin da org A lê ZERO convites da org B", () => {
    const vizinha = countAs(
      ADMIN_A,
      `select count(*) from public.team_invites where organization_id = '${ORG_B}';`,
    );
    expect(vizinha).toBe(0);
  });

  it("o admin da org A não alcança nenhuma linha da tabela inteira além das suas", () => {
    const total = countAs(ADMIN_A, `select count(*) from public.team_invites;`);
    const proprios = countAs(
      ADMIN_A,
      `select count(*) from public.team_invites where organization_id = '${ORG_A}';`,
    );
    expect(total).toBe(proprios);
  });

  it("o AGENT da própria org não lê a lista de convites — a policy exige manager+", () => {
    const doAgent = countAs(
      AGENT_A,
      `select count(*) from public.team_invites where organization_id = '${ORG_A}';`,
    );
    expect(doAgent).toBe(0);
  });

  it("o admin da org B lê os dele (controle positivo do outro lado)", () => {
    const proprios = countAs(
      ADMIN_B,
      `select count(*) from public.team_invites where organization_id = '${ORG_B}';`,
    );
    expect(proprios).toBeGreaterThan(0);
  });

  it("o MANAGER da própria org não consegue REVOGAR (escrita exige admin+)", () => {
    // A prova é por contagem do estado depois, não pela mensagem de erro —
    // `raise`/exceção de policy sai por um canal que este helper não lê.
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${MANAGER_A}"}', false);
      do $$
      begin
        update public.team_invites set status = 'revoked'
          where organization_id = '${ORG_A}';
      exception when others then
        null;
      end
      $$;
    `);

    const aindaPendentes = sql(`
      reset role;
      select count(*) from public.team_invites
        where organization_id = '${ORG_A}' and status = 'revoked';
    `);
    expect(aindaPendentes.split("\n").pop()).toBe("0");
  });

  it("o admin da org B não consegue escrever num convite da org A (cross-tenant write)", () => {
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${ADMIN_B}"}', false);
      do $$
      begin
        update public.team_invites set status = 'revoked'
          where organization_id = '${ORG_A}';
      exception when others then
        null;
      end
      $$;
    `);

    const aindaPendentes = sql(`
      reset role;
      select count(*) from public.team_invites
        where organization_id = '${ORG_A}' and status = 'revoked';
    `);
    expect(aindaPendentes.split("\n").pop()).toBe("0");
  });
});
