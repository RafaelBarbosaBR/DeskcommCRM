import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * As três tabelas da chamada de voz (migration 0247) NÃO VAZAM ENTRE
 * ORGANIZAÇÕES — e a ESCRITA respeita o papel de cada uma.
 *
 * Arquivo próprio, não uma linha em `rls-isolation.test.ts`: aquele molde só
 * mede LEITURA (um `agent` por org, cross-org zero + controle positivo). As
 * três tabelas aqui têm leitura aberta a qualquer membro — então ENTRARIAM
 * ali sem estourar o controle positivo —, mas a ESCRITA é fechada por papel
 * (`admin`+ em `wacalls_sessions`/`org_voice_calls`, `agent`+ em
 * `voice_calls`), e é esse segundo eixo que só um arquivo próprio mede —
 * mesmo raciocínio já usado em `convites-de-equipe-rls.test.ts` (migration
 * 0245).
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
const ORG_A = "e2222222-0000-4000-8000-0000000000a1";
const ORG_B = "e2222222-0000-4000-8000-0000000000a2";
const ADMIN_A = "e2222222-1111-4000-8000-0000000000a1";
const AGENT_A = "e2222222-1111-4000-8000-0000000000a2";
const VIEWER_A = "e2222222-1111-4000-8000-0000000000a3";
const ADMIN_B = "e2222222-1111-4000-8000-0000000000a4";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ADMIN_A}',  'voz-admin-a@invariant.test'),
      ('${AGENT_A}',  'voz-agent-a@invariant.test'),
      ('${VIEWER_A}', 'voz-viewer-a@invariant.test'),
      ('${ADMIN_B}',  'voz-admin-b@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'voz-inv-a', 'Voz Invariant A', 'Voz A'),
      ('${ORG_B}', 'voz-inv-b', 'Voz Invariant B', 'Voz B')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ADMIN_A}',  '${ORG_A}', 'admin',  now()),
      ('${AGENT_A}',  '${ORG_A}', 'agent',  now()),
      ('${VIEWER_A}', '${ORG_A}', 'viewer', now()),
      ('${ADMIN_B}',  '${ORG_B}', 'admin',  now())
      on conflict do nothing;

    insert into public.wacalls_sessions (organization_id, wacalls_session_id, status)
    select v.org, 'sid-' || v.org::text, 'open'
      from (values ('${ORG_A}'::uuid), ('${ORG_B}'::uuid)) as v(org)
     where not exists (select 1 from public.wacalls_sessions w where w.organization_id = v.org);

    insert into public.org_voice_calls (organization_id, enabled)
    select v.org, true
      from (values ('${ORG_A}'::uuid), ('${ORG_B}'::uuid)) as v(org)
     where not exists (select 1 from public.org_voice_calls o where o.organization_id = v.org);

    insert into public.voice_calls (organization_id, wacalls_call_id, direction, peer_phone, status)
    select v.org, 'call-' || v.org::text, 'inbound', '+5511900000000', 'ended'
      from (values ('${ORG_A}'::uuid), ('${ORG_B}'::uuid)) as v(org)
     where not exists (select 1 from public.voice_calls c where c.organization_id = v.org);
  `);
});

describe("wacalls_sessions — isolamento e gate de escrita", () => {
  it("o admin da org A lê a própria sessão (controle positivo)", () => {
    expect(countAs(ADMIN_A, `select count(*) from public.wacalls_sessions where organization_id = '${ORG_A}';`)).toBeGreaterThan(0);
  });
  it("o VIEWER da própria org também lê — a leitura é aberta a todo membro", () => {
    expect(countAs(VIEWER_A, `select count(*) from public.wacalls_sessions where organization_id = '${ORG_A}';`)).toBeGreaterThan(0);
  });
  it("o admin da org A lê ZERO sessões da org B", () => {
    expect(countAs(ADMIN_A, `select count(*) from public.wacalls_sessions where organization_id = '${ORG_B}';`)).toBe(0);
  });
  it("o AGENT da própria org não consegue desparear — a escrita exige admin+", () => {
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${AGENT_A}"}', false);
      do $$
      begin
        update public.wacalls_sessions set archived_at = now() where organization_id = '${ORG_A}';
      exception when others then null;
      end
      $$;
    `);
    const aindaAtiva = sql(`
      reset role;
      select count(*) from public.wacalls_sessions where organization_id = '${ORG_A}' and archived_at is null;
    `);
    expect(aindaAtiva.split("\n").pop()).toBe("1");
  });
  it("o admin da org A consegue escrever na própria sessão (controle positivo de escrita)", () => {
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${ADMIN_A}"}', false);
      update public.wacalls_sessions set wacalls_jid = 'jid-teste' where organization_id = '${ORG_A}';
    `);
    const gravado = sql(`
      reset role;
      select count(*) from public.wacalls_sessions where organization_id = '${ORG_A}' and wacalls_jid = 'jid-teste';
    `);
    expect(gravado.split("\n").pop()).toBe("1");
  });
});

describe("org_voice_calls — isolamento e gate de escrita", () => {
  it("o admin da org A lê a própria escolha (controle positivo)", () => {
    expect(countAs(ADMIN_A, `select count(*) from public.org_voice_calls where organization_id = '${ORG_A}';`)).toBeGreaterThan(0);
  });
  it("o admin da org A lê ZERO escolhas da org B", () => {
    expect(countAs(ADMIN_A, `select count(*) from public.org_voice_calls where organization_id = '${ORG_B}';`)).toBe(0);
  });
  it("o AGENT da própria org não consegue desligar a chamada de voz — a escrita exige admin+", () => {
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${AGENT_A}"}', false);
      do $$
      begin
        update public.org_voice_calls set enabled = false where organization_id = '${ORG_A}';
      exception when others then null;
      end
      $$;
    `);
    const aindaLigada = sql(`
      reset role;
      select count(*) from public.org_voice_calls where organization_id = '${ORG_A}' and enabled = true;
    `);
    expect(aindaLigada.split("\n").pop()).toBe("1");
  });
});

describe("voice_calls — isolamento e gate de escrita", () => {
  it("o agent da org A lê a própria chamada (controle positivo)", () => {
    expect(countAs(AGENT_A, `select count(*) from public.voice_calls where organization_id = '${ORG_A}';`)).toBeGreaterThan(0);
  });
  it("o VIEWER da própria org também lê — a leitura é aberta a todo membro", () => {
    expect(countAs(VIEWER_A, `select count(*) from public.voice_calls where organization_id = '${ORG_A}';`)).toBeGreaterThan(0);
  });
  it("o agent da org A lê ZERO chamadas da org B", () => {
    expect(countAs(AGENT_A, `select count(*) from public.voice_calls where organization_id = '${ORG_B}';`)).toBe(0);
  });
  it("o VIEWER da própria org não consegue discar — a escrita exige agent+", () => {
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${VIEWER_A}"}', false);
      do $$
      begin
        insert into public.voice_calls (organization_id, wacalls_call_id, direction, peer_phone, status)
          values ('${ORG_A}', 'call-forjada-pelo-viewer', 'outbound', '+5511911112222', 'starting');
      exception when others then null;
      end
      $$;
    `);
    const forjada = sql(`
      reset role;
      select count(*) from public.voice_calls where wacalls_call_id = 'call-forjada-pelo-viewer';
    `);
    expect(forjada.split("\n").pop()).toBe("0");
  });
  it("o agent da org A consegue discar na própria org (controle positivo de escrita)", () => {
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${AGENT_A}"}', false);
      insert into public.voice_calls (organization_id, wacalls_call_id, direction, peer_phone, status, created_by)
        values ('${ORG_A}', 'call-legitima-do-agent', 'outbound', '+5511933334444', 'starting', '${AGENT_A}');
    `);
    const gravada = sql(`
      reset role;
      select count(*) from public.voice_calls where wacalls_call_id = 'call-legitima-do-agent';
    `);
    expect(gravada.split("\n").pop()).toBe("1");
  });
});
