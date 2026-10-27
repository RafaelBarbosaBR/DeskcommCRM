/**
 * 0685 — evento LIGADO a uma conversa segue a visibilidade dela, não só o de
 * `entity_kind = 'conversation'`: a nota (`conversation_note`, cujo `entity_id`
 * é o id da conversa), os eventos que trazem `payload.conversation_id`
 * (mensagem, job) — inclusive o de conversa/nota sem `entity_id` — e o aviso
 * da Central (`central.aviso_criado`) cujo `ref_kind` é `conversation`. E a
 * atribuição de conversa fora da visibilidade não toca a linha: ela é decidida
 * no WHERE do `for no key update`.
 *
 * `GOV_CONV_AGENT_B` é de `GOV_AGENT_B`; `GOV_AGENT_A`, em modo `own`, não a vê.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_CONV_AGENT_B,
  GOV_MANAGER,
  GOV_ORG,
  GOV_VIEWER,
  countAs,
  lastLine,
  seedGov,
  sql,
} from "./gov-helpers";

const EV_NOTA = "e0e0e0e0-0685-4000-8000-000000000011";
const EV_MENSAGEM = "e0e0e0e0-0685-4000-8000-000000000012";
const EV_JOB = "e0e0e0e0-0685-4000-8000-000000000013";
const EV_MENSAGEM_ID_SEM_FORMA = "e0e0e0e0-0685-4000-8000-000000000014";
const EV_CONVERSA = "e0e0e0e0-0685-4000-8000-000000000015";
// Nota cujo payload não repete a conversa: só o `entity_id` a identifica.
const EV_NOTA_SO_ENTIDADE = "e0e0e0e0-0685-4000-8000-000000000019";
// Uuid com forma certa que não aponta para conversa da organização (no payload e no ref_id do aviso).
const EV_UUID_SEM_CONVERSA = "e0e0e0e0-0685-4000-8000-000000000031";
const EV_REF_SEM_CONVERSA = "e0e0e0e0-0685-4000-8000-000000000032";
const UUID_SEM_CONVERSA = "e0e0e0e0-0685-4000-8000-0000000000aa";
// Administrador da plataforma que não é membro da organização.
const ADMIN_PLATAFORMA = "e0e0e0e0-0685-4000-8000-0000000000fd";
// `payload.conversation_id` que não é uuid: texto, vazio e número.
const EV_MALFORMADOS = [
  "e0e0e0e0-0685-4000-8000-000000000016",
  "e0e0e0e0-0685-4000-8000-000000000017",
  "e0e0e0e0-0685-4000-8000-000000000018",
];

// Conversa e nota SEM `entity_id`: a conversa vem do `payload.conversation_id`.
const EV_CONVERSA_SEM_ENTIDADE = "e0e0e0e0-0685-4000-8000-000000000021";
const EV_NOTA_SEM_ENTIDADE = "e0e0e0e0-0685-4000-8000-000000000022";
// Avisos da Central (ids em `agent_inbox_items`); o evento nasce do trigger de produção.
const AVISO_DA_CONVERSA = "e0e0e0e0-0685-4000-8000-000000000023";
const AVISO_DE_CONTATO = "e0e0e0e0-0685-4000-8000-000000000024";
const contarAviso = (aviso: string) =>
  `select count(*) from public.event_log where event_type = 'central.aviso_criado' and entity_id = '${aviso}';`;

const contar = (id: string) => `select count(*) from public.event_log where id = '${id}';`;
const modo = (m: string) =>
  sql(`update public.organizations set settings = jsonb_set(coalesce(settings,'{}'), '{visibility_mode}', '"${m}"') where id = '${GOV_ORG}';`);

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.event_log (id, organization_id, event_type, entity_kind, entity_id, payload, status) values
      ('${EV_NOTA}',     '${GOV_ORG}', 'user.mentioned', 'conversation_note', '${GOV_CONV_AGENT_B}',
        jsonb_build_object('conversation_id', '${GOV_CONV_AGENT_B}', 'body_preview', 'nota interna'), 'done'),
      ('${EV_MENSAGEM}', '${GOV_ORG}', 'message.sent', 'message', gen_random_uuid(),
        jsonb_build_object('conversation_id', '${GOV_CONV_AGENT_B}'), 'done'),
      ('${EV_CONVERSA_SEM_ENTIDADE}', '${GOV_ORG}', 'conversation.claimed', 'conversation', null,
        jsonb_build_object('conversation_id', '${GOV_CONV_AGENT_B}'), 'done'),
      ('${EV_NOTA_SEM_ENTIDADE}', '${GOV_ORG}', 'user.mentioned', 'conversation_note', null,
        jsonb_build_object('conversation_id', '${GOV_CONV_AGENT_B}'), 'done'),
      ('${EV_JOB}',      '${GOV_ORG}', 'conversation.autonomous_turn_revoked', 'job', gen_random_uuid(),
        jsonb_build_object('conversation_id', '${GOV_CONV_AGENT_B}'), 'done'),
      ('${EV_MENSAGEM_ID_SEM_FORMA}', '${GOV_ORG}', 'message.sent', 'message', gen_random_uuid(),
        jsonb_build_object('conversation_id', '5511999999999@c.us'), 'done'),
      ('${EV_CONVERSA}', '${GOV_ORG}', 'conversation.claimed', 'conversation', '${GOV_CONV_AGENT_B}', '{}'::jsonb, 'done'),
      ('${EV_NOTA_SO_ENTIDADE}', '${GOV_ORG}', 'user.mentioned', 'conversation_note', '${GOV_CONV_AGENT_B}',
        jsonb_build_object('body_preview', 'nota interna'), 'done'),
      ('${EV_UUID_SEM_CONVERSA}', '${GOV_ORG}', 'message.sent', 'message', gen_random_uuid(),
        jsonb_build_object('conversation_id', '${UUID_SEM_CONVERSA}'), 'done'),
      ('${EV_REF_SEM_CONVERSA}', '${GOV_ORG}', 'central.aviso_criado', 'agent_inbox_item', gen_random_uuid(),
        jsonb_build_object('ref_kind', 'conversation', 'ref_id', '${UUID_SEM_CONVERSA}'), 'done'),
      ('${EV_MALFORMADOS[0]}', '${GOV_ORG}', 'message.sent', 'message', gen_random_uuid(), '{"conversation_id":"x"}'::jsonb, 'done'),
      ('${EV_MALFORMADOS[1]}', '${GOV_ORG}', 'message.sent', 'message', gen_random_uuid(), '{"conversation_id":""}'::jsonb, 'done'),
      ('${EV_MALFORMADOS[2]}', '${GOV_ORG}', 'message.sent', 'message', gen_random_uuid(), '{"conversation_id":12345}'::jsonb, 'done')
      on conflict (id) do nothing;
    insert into public.agent_inbox_items (id, organization_id, kind, ref_kind, ref_id, title) values
      ('${AVISO_DA_CONVERSA}', '${GOV_ORG}', 'other', 'conversation', '${GOV_CONV_AGENT_B}', 'aviso da conversa'),
      ('${AVISO_DE_CONTATO}',  '${GOV_ORG}', 'other', 'contact',      gen_random_uuid(),     'aviso de contato')
      on conflict (id) do nothing;
  `);
});

beforeEach(() => {
  modo("own");
  sql(`update public.conversations set assigned_to_user_id = '${GOV_AGENT_B}', assignee_kind = 'user', status = 'claimed'
        where id = '${GOV_CONV_AGENT_B}';`);
});

describe("0685 — eventos ligados a uma conversa seguem a visibilidade dela", () => {
  it.each([EV_NOTA, EV_NOTA_SO_ENTIDADE, EV_MENSAGEM, EV_JOB])("o dono lê (controle positivo) e o colega em modo own não (%s)", (ev) => {
    expect(countAs(GOV_AGENT_B, contar(ev))).toBe(1);
    expect(countAs(GOV_AGENT_A, contar(ev))).toBe(0);
  });

  it("modo all: o colega volta a ler", () => {
    modo("all");
    expect(countAs(GOV_AGENT_A, contar(EV_NOTA))).toBe(1);
    expect(countAs(GOV_AGENT_A, contar(EV_MENSAGEM))).toBe(1);
  });

  it("conversation_id sem forma de uuid não restringe nada", () => {
    expect(countAs(GOV_AGENT_A, contar(EV_MENSAGEM_ID_SEM_FORMA))).toBe(1);
  });

  it.each([EV_UUID_SEM_CONVERSA, EV_REF_SEM_CONVERSA])(
    "uuid que não aponta para conversa da organização fica oculto ao atendente, e a gestão lê (%s)",
    (ev) => {
      expect(countAs(GOV_AGENT_A, contar(ev))).toBe(0);
      expect(countAs(GOV_AGENT_B, contar(ev))).toBe(0);
      expect(countAs(GOV_MANAGER, contar(ev))).toBe(1);
    },
  );

  it("administrador da plataforma fora da organização lê os eventos ligados à conversa", () => {
    sql(`insert into auth.users (id, email) values ('${ADMIN_PLATAFORMA}', 'plataforma-0685@invariant.test') on conflict do nothing;
         insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason)
           values ('${ADMIN_PLATAFORMA}', '${ADMIN_PLATAFORMA}', 'full', false, 'invariante 0685') on conflict (user_id) do nothing;`);
    for (const ev of [EV_NOTA, EV_MENSAGEM, EV_UUID_SEM_CONVERSA]) expect(countAs(ADMIN_PLATAFORMA, contar(ev))).toBe(1);
  });

  it("gestão lê os eventos ligados à conversa de qualquer atendente", () => {
    for (const ev of [EV_NOTA, EV_NOTA_SO_ENTIDADE, EV_MENSAGEM, EV_JOB]) expect(countAs(GOV_MANAGER, contar(ev))).toBe(1);
  });

  it("conversation_id malformado não derruba a leitura e segue o pertencimento à organização", () => {
    const ids = EV_MALFORMADOS.map((id) => `'${id}'`).join(", ");
    expect(countAs(GOV_AGENT_A, `select count(*) from public.event_log where id in (${ids});`)).toBe(3);
    // A tabela inteira, pela sessão do atendente: a policy roda em toda linha e não lança.
    expect(countAs(GOV_AGENT_A, "select count(*) from public.event_log;")).toBeGreaterThanOrEqual(3);
    const fora = "e0e0e0e0-0685-4000-8000-0000000000fe";
    sql(`insert into auth.users (id, email) values ('${fora}', 'fora-0685b@invariant.test') on conflict do nothing;`);
    expect(countAs(fora, `select count(*) from public.event_log where id in (${ids});`)).toBe(0);
  });

  it.each([EV_CONVERSA_SEM_ENTIDADE, EV_NOTA_SEM_ENTIDADE])(
    "conversa/nota sem entity_id cai no payload.conversation_id: dono e gestão leem, colega own não (%s)",
    (ev) => {
      expect(countAs(GOV_AGENT_B, contar(ev))).toBe(1);
      expect(countAs(GOV_MANAGER, contar(ev))).toBe(1);
      expect(countAs(GOV_AGENT_A, contar(ev))).toBe(0);
    },
  );

  it("aviso da Central sobre uma conversa segue a visibilidade dela pelo ref_id", () => {
    // O trigger de produção emitiu um evento por aviso (sem isto, o zero abaixo seria vazio).
    expect(Number(lastLine(sql(contarAviso(AVISO_DA_CONVERSA))))).toBe(1);
    expect(countAs(GOV_AGENT_B, contarAviso(AVISO_DA_CONVERSA))).toBe(1);
    expect(countAs(GOV_MANAGER, contarAviso(AVISO_DA_CONVERSA))).toBe(1);
    expect(countAs(GOV_AGENT_A, contarAviso(AVISO_DA_CONVERSA))).toBe(0);
  });

  it("aviso da Central que não é de conversa segue o pertencimento à organização (controle)", () => {
    expect(Number(lastLine(sql(contarAviso(AVISO_DE_CONTATO))))).toBe(1);
    expect(countAs(GOV_AGENT_A, contarAviso(AVISO_DE_CONTATO))).toBe(1);
  });

  it("viewer lê pela visão ampla, como em fn_can_view_conversation", () => {
    expect(countAs(GOV_VIEWER, `select count(*) from public.conversations where id = '${GOV_CONV_AGENT_B}';`)).toBe(1);
    for (const ev of [EV_CONVERSA, EV_NOTA, EV_MENSAGEM]) expect(countAs(GOV_VIEWER, contar(ev))).toBe(1);
  });
});

describe("0685 — atribuição de conversa fora da visibilidade não bloqueia a linha", () => {
  // Bloquear a linha (for no key update) atribui um xid à transação; ler não.
  const travouALinha = (quem: string, expected: string) => {
    const out = sql(`
      set role authenticated;
      begin;
      select set_config('request.jwt.claims', '{"sub":"${quem}"}', true);
      select 'n=' || count(*) from public.fn_conversation_assign('${GOV_ORG}', '${GOV_CONV_AGENT_B}', '${GOV_AGENT_A}', 'transfer', '${expected}', true);
      select 'xid=' || (txid_current_if_assigned() is not null);
      rollback;
    `);
    return { linhas: out.match(/n=(\d+)/)?.[1], travou: out.match(/xid=(\w+)/)?.[1] };
  };

  it("conversa oculta: zero linhas e nenhuma trava", () => {
    expect(travouALinha(GOV_AGENT_A, GOV_AGENT_B)).toEqual({ linhas: "0", travou: "false" });
  });

  it("conversa visível com expected errado: zero linhas, mas a linha foi travada (controle)", () => {
    expect(travouALinha(GOV_AGENT_B, GOV_AGENT_A)).toEqual({ linhas: "0", travou: "true" });
  });
});
