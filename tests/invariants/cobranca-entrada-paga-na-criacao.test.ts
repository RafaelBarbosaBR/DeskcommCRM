import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";
import {
  chaveDeCobranca, comoServidor, criarOrg, criarPlano, criarUsuarios, erroDe, numero, tornarPlatformAdmin, uuid, valor,
} from "./cobranca-helpers";

/**
 * ENTRADA PAGA E PLANO DO CADASTRO — migration 0679 (#2846), com a exceção do
 * doc 146 (opção B, 15/10).
 *
 * Com a cobrança ligada, `fn_trial_na_criacao_da_org`:
 *  - usa o plano escolhido no cadastro (`settings.cobranca_signup_plan_id`, que
 *    some na mesma transação) ou, sem escolha, o padrão;
 *  - plano de 0 dias de teste: a org nasce SUSPENSA por cobrança, com a entrada
 *    pendente, até o 1º pagamento confirmado (quem reativa é a régua);
 *  - sem padrão e com plano oferecido: recusa com `plano_obrigatorio`;
 *  - sem plano NENHUM (nem padrão, nem oferecido): a org nasce isenta, como
 *    antes da 0679. O espelho TS do critério é `lib/cobranca/cadastro.ts`.
 *
 * O banco é limpo por arquivo, então os únicos planos aqui são os deste arquivo.
 */

const P = "c0b00660-0000-4000-8000";
const org = (n: number) => uuid(P, n);
const CLIENTE = uuid(P, 101);
const DONO = uuid(P, 102);
const PADRAO = uuid(P, 901);
const OFERECIDO = uuid(P, 902);
const SEM_TESTE = uuid(P, 903);

/** `estado|plano|dias de teste grátis`, ou `isenta`. */
function assinatura(orgId: string): string {
  return valor(`select coalesce((select estado || '|' || plano_id || '|' || round(extract(epoch from (trial_ate - created_at)) / 86400)
                  from public.cobranca_assinaturas where organization_id = '${orgId}'), 'isenta');`);
}
const situacao = (orgId: string) =>
  valor(`select status || '|' || coalesce(suspended_kind, '-') from public.organizations where id = '${orgId}';`);
const existe = (orgId: string) => numero(`select count(*) from public.organizations where id = '${orgId}';`);

function orgComEscolha(id: string, plano: string): string {
  return `insert into public.organizations (id, slug, legal_name, display_name, created_by, settings)
            values ('${id}', 'cob-entrada-${id.slice(-3)}', 'x', 'x', '${CLIENTE}', '{"cobranca_signup_plan_id": "${plano}"}'::jsonb)`;
}

/** Roda `fn` com só estes planos vigentes no papel de padrão e de oferecidos; restaura depois. */
function comPlanos(p: { padrao: string | null; oferecidos: string[] }, fn: () => void): void {
  // Em dois comandos: só pode haver UM padrão, e trocar num UPDATE só esbarra no índice.
  sql(`update public.cobranca_planos set padrao_no_cadastro = false;
       update public.cobranca_planos set padrao_no_cadastro = true where id::text = '${p.padrao ?? ""}';
       update public.cobranca_planos
          set oferecido_ao_cliente = (id::text = any (array[${p.oferecidos.map((o) => `'${o}'`).join(",") || "''"}]::text[]));`);
  try {
    fn();
  } finally {
    sql(`update public.cobranca_planos set padrao_no_cadastro = false, oferecido_ao_cliente = true;
         update public.cobranca_planos set padrao_no_cadastro = true where id = '${PADRAO}';`);
  }
}

beforeAll(() => {
  criarUsuarios([
    [CLIENTE, "cliente-entrada-0660@invariant.test"],
    [DONO, "dono-entrada-0660@invariant.test"],
  ]);
  tornarPlatformAdmin(DONO, "full", DONO);
  criarPlano({ id: PADRAO, nome: "Cadastro", trialDias: 7, padrao: true });
  criarPlano({ id: OFERECIDO, nome: "Oferecido", trialDias: 30 });
  criarPlano({ id: SEM_TESTE, nome: "Sem teste grátis", trialDias: 0 });
  chaveDeCobranca("ligado");
});

describe("0679 — entrada paga na criação da organização", () => {
  it("⭐ plano de 0 dias (padrão): nasce em trial vencido, SUSPENSA por cobrança e com a entrada pendente", () => {
    comPlanos({ padrao: SEM_TESTE, oferecidos: [SEM_TESTE] }, () => criarOrg(org(1), "cob-entrada-1", CLIENTE));
    expect(assinatura(org(1))).toBe(`trial|${SEM_TESTE}|0`);
    expect(situacao(org(1))).toBe("suspended|cobranca");
    expect(valor(`select pagamento_inicial_pendente::text from public.cobranca_assinaturas where organization_id = '${org(1)}';`)).toBe("true");
  });

  it("plano com dias de teste: nasce ativa, sem entrada pendente (o controle do caso acima)", () => {
    criarOrg(org(2), "cob-entrada-2", CLIENTE);
    expect(assinatura(org(2))).toBe(`trial|${PADRAO}|7`);
    expect(situacao(org(2))).toBe("active|-");
    expect(valor(`select pagamento_inicial_pendente::text from public.cobranca_assinaturas where organization_id = '${org(2)}';`)).toBe("false");
  });

  it("⭐ fn_create_tenant_with_owner com plano de 0 dias: a org do dono também nasce suspensa", () => {
    const corpo = JSON.stringify({ display_name: "Entrada 3", slug: "cob-entrada-tenant-3", owner_email: "dono-real-3-0660@invariant.test", plano_id: SEM_TESTE });
    const id = valor(comoServidor(`select public.fn_create_tenant_with_owner('${DONO}', '${uuid(P, 503)}', '${corpo}'::jsonb, 'abcd')->>'id'`));
    expect(assinatura(id)).toBe(`trial|${SEM_TESTE}|0`);
    expect(situacao(id)).toBe("suspended|cobranca");
  });

  it("⭐ plano escolhido no cadastro: vale o escolhido, e o campo transitório some de settings", () => {
    sql(`${orgComEscolha(org(4), OFERECIDO)};`);
    expect(assinatura(org(4))).toBe(`trial|${OFERECIDO}|30`);
    expect(valor(`select (settings ? 'cobranca_signup_plan_id')::text from public.organizations where id = '${org(4)}';`)).toBe("false");
  });

  // A escolha que deixou de valer (plano tirado do cadastro entre o cadastro e a
  // confirmação do e-mail, ou metadata adulterada) vale como "sem escolha". Antes
  // ela recusava, e a recuperação reenviava a mesma escolha: empresa travada.
  it("⭐ plano escolhido que não é (mais) oferecido: vale como sem escolha e a org nasce no PADRÃO, sem o campo", () => {
    comPlanos({ padrao: PADRAO, oferecidos: [PADRAO] }, () => sql(`${orgComEscolha(org(5), OFERECIDO)};`));
    expect(assinatura(org(5))).toBe(`trial|${PADRAO}|7`);
    expect(valor(`select (settings ? 'cobranca_signup_plan_id')::text from public.organizations where id = '${org(5)}';`)).toBe("false");
  });

  it("plano escolhido inválido e sem padrão (com oferecido): a mesma recusa de quem não escolheu — plano_obrigatorio", () => {
    comPlanos({ padrao: null, oferecidos: [OFERECIDO] }, () => {
      expect(erroDe(orgComEscolha(org(10), SEM_TESTE))).toContain("plano_obrigatorio");
      expect(erroDe(orgComEscolha(org(11), "nao-e-uuid"))).toContain("plano_obrigatorio");
    });
    expect(existe(org(10)) + existe(org(11))).toBe(0);
  });
});

describe("doc 146, opção B — quem não tem plano nenhum segue como antes", () => {
  it("⭐ sem plano nenhum (nem padrão, nem oferecido): o cliente cria a org e ela nasce isenta", () => {
    comPlanos({ padrao: null, oferecidos: [] }, () => criarOrg(org(6), "cob-entrada-6", CLIENTE));
    expect(existe(org(6))).toBe(1);
    expect(assinatura(org(6))).toBe("isenta");
    expect(situacao(org(6))).toBe("active|-");
  });

  it("⭐ plano oferecido e sem padrão: o cadastro sem escolha é recusado com plano_obrigatorio", () => {
    comPlanos({ padrao: null, oferecidos: [OFERECIDO] }, () => {
      expect(erroDe(`insert into public.organizations (id, slug, legal_name, display_name, created_by)
        values ('${org(7)}', 'cob-entrada-7', 'x', 'x', '${CLIENTE}')`)).toContain("plano_obrigatorio");
    });
    expect(existe(org(7))).toBe(0);
  });

  it("plano oferecido só ARQUIVADO não conta: segue sem plano nenhum e nasce isenta", () => {
    sql(`update public.cobranca_planos set arquivado_em = now() where id = '${OFERECIDO}';`);
    try {
      comPlanos({ padrao: null, oferecidos: [OFERECIDO] }, () => criarOrg(org(8), "cob-entrada-8", CLIENTE));
    } finally {
      sql(`update public.cobranca_planos set arquivado_em = null where id = '${OFERECIDO}';`);
    }
    expect(assinatura(org(8))).toBe("isenta");
  });

  it("com padrão: nasce no padrão", () => {
    criarOrg(org(9), "cob-entrada-9", CLIENTE);
    expect(assinatura(org(9))).toBe(`trial|${PADRAO}|7`);
  });
});
