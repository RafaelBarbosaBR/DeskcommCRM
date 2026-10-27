/**
 * 0685 — o registro de eventos (`event_log`) acompanha a visibilidade da conversa.
 *
 * Evento ligado a uma conversa só é legível pela sessão de quem pode abrir a
 * conversa (`fn_can_view_conversation`, mesmo molde de `conversation_notes`).
 * A conversa do evento é resolvida pelo `entity_id` (`conversation`/
 * `conversation_note`), por `payload.conversation_id`, ou pelo `ref_id` do
 * aviso da Central (`payload.ref_kind = 'conversation'`). Valor SEM forma de
 * uuid não restringe (segue o pertencimento à organização); uuid que não aponta
 * para conversa da organização fica oculto ao atendente. Workers leem com a
 * service role e não passam aqui. Os casos de nota, payload e aviso estão em
 * `eventos-ligados-a-conversa-seguem-a-visibilidade.test.ts`.
 *
 * `GOV_CONV_AGENT_B` é de `GOV_AGENT_B`; `GOV_AGENT_A` é do mesmo papel e da
 * mesma organização, e só não a enxerga porque não é o dono (modo `own`).
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  GOV_ADMIN,
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_CONV_AGENT_B,
  GOV_CONV_UNASSIGNED,
  GOV_LEAD,
  GOV_MANAGER,
  GOV_ORG,
  countAs,
  seedGov,
  sql,
} from "./gov-helpers";

const EV_CONVERSA_B = "e0e0e0e0-0685-4000-8000-000000000001";
const EV_CONVERSA_LIVRE = "e0e0e0e0-0685-4000-8000-000000000002";
const EV_LEAD = "e0e0e0e0-0685-4000-8000-000000000003";
const EV_SEM_ENTIDADE = "e0e0e0e0-0685-4000-8000-000000000004";

const contar = (id: string) => `select count(*) from public.event_log where id = '${id}';`;
const modo = (m: string) =>
  sql(`update public.organizations set settings = jsonb_set(coalesce(settings,'{}'), '{visibility_mode}', '"${m}"') where id = '${GOV_ORG}';`);

beforeAll(() => {
  seedGov();
  sql(`
    update public.conversations set assigned_to_user_id = '${GOV_AGENT_B}', assignee_kind = 'user', status = 'claimed'
     where id = '${GOV_CONV_AGENT_B}';
    insert into public.event_log (id, organization_id, event_type, entity_kind, entity_id, payload, status) values
      ('${EV_CONVERSA_B}',     '${GOV_ORG}', 'conversation.transferred', 'conversation', '${GOV_CONV_AGENT_B}',   jsonb_build_object('assigned_to_user_id', '${GOV_AGENT_B}'), 'done'),
      ('${EV_CONVERSA_LIVRE}', '${GOV_ORG}', 'conversation.claimed',     'conversation', '${GOV_CONV_UNASSIGNED}', '{}'::jsonb, 'done'),
      ('${EV_LEAD}',           '${GOV_ORG}', 'lead.stage_changed',       'lead',         '${GOV_LEAD}',            '{}'::jsonb, 'done'),
      ('${EV_SEM_ENTIDADE}',   '${GOV_ORG}', 'conversation.claimed',     'conversation', null,                     '{}'::jsonb, 'done')
      on conflict (id) do nothing;
  `);
});

beforeEach(() => modo("own"));

describe("0685 — evento de conversa segue a visibilidade da conversa", () => {
  it("dono da conversa lê o evento dela (controle positivo)", () => {
    expect(countAs(GOV_AGENT_B, contar(EV_CONVERSA_B))).toBe(1);
  });

  it("atendente em modo own não lê evento da conversa de um colega", () => {
    expect(countAs(GOV_AGENT_A, `select count(*) from public.conversations where id = '${GOV_CONV_AGENT_B}';`)).toBe(0);
    expect(countAs(GOV_AGENT_A, contar(EV_CONVERSA_B))).toBe(0);
    expect(countAs(GOV_AGENT_A, contar(EV_CONVERSA_LIVRE))).toBe(0);
  });

  it("own_and_unassigned: conversa sem dono volta a ser legível, a do colega não", () => {
    modo("own_and_unassigned");
    expect(countAs(GOV_AGENT_A, contar(EV_CONVERSA_LIVRE))).toBe(1);
    expect(countAs(GOV_AGENT_A, contar(EV_CONVERSA_B))).toBe(0);
  });

  it.each([GOV_MANAGER, GOV_ADMIN])("gestão lê os eventos de toda a operação (%s)", (quem) => {
    expect(countAs(quem, contar(EV_CONVERSA_B))).toBe(1);
    expect(countAs(quem, contar(EV_CONVERSA_LIVRE))).toBe(1);
  });

  it("eventos sem conversa resolvível seguem só o pertencimento à organização", () => {
    expect(countAs(GOV_AGENT_A, contar(EV_LEAD))).toBe(1);
    expect(countAs(GOV_AGENT_A, contar(EV_SEM_ENTIDADE))).toBe(1);
  });

  it("quem não é da organização não lê nada", () => {
    const fora = "e0e0e0e0-0685-4000-8000-0000000000ff";
    sql(`insert into auth.users (id, email) values ('${fora}', 'fora-0685@invariant.test') on conflict do nothing;`);
    expect(countAs(fora, contar(EV_LEAD))).toBe(0);
    expect(countAs(fora, contar(EV_CONVERSA_B))).toBe(0);
  });
});
