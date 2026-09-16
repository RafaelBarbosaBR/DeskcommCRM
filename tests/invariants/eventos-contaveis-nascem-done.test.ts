import { describe, expect, it } from "vitest";
import { sql, seedGov, GOV_ORG } from "./gov-helpers";

/**
 * `crm.activity_write_failed`/`whatsapp.chat_id_not_recognized`/
 * `whatsapp.conversation_mark_failed` são emitidos só pra `COUNT(*)` — sem
 * consumidor nenhum. Sem o gatilho da migration 0251, ficavam presos em
 * `status='pending'` para sempre (o drain só olha `pending`), reprocessados
 * a cada corrida sem nunca sair dali. Os três precisam nascer `done`; todo o
 * resto continua nascendo `pending` normalmente (controle negativo).
 */

const TIPOS_CONTAVEIS = [
  "crm.activity_write_failed",
  "whatsapp.chat_id_not_recognized",
  "whatsapp.conversation_mark_failed",
] as const;

describe("event_log — tipos contáveis nascem done", () => {
  seedGov();

  for (const tipo of TIPOS_CONTAVEIS) {
    it(`${tipo} nasce status='done'`, () => {
      const out = sql(`
        select public.emit_event('${tipo}', 'crm_lead', null, '{}'::jsonb, '{}'::jsonb, '${GOV_ORG}');
      `);
      const eventId = out.trim().split("\n").pop()!.trim();
      const status = sql(`select status from public.event_log where id = '${eventId}';`).trim();
      expect(status).toBe("done");
    });
  }

  it("controle negativo: um evento comum (com consumidor de verdade) continua nascendo pending", () => {
    const out = sql(`
      select public.emit_event('crm.lead_created', 'crm_lead', null, '{}'::jsonb, '{}'::jsonb, '${GOV_ORG}');
    `);
    const eventId = out.trim().split("\n").pop()!.trim();
    const status = sql(`select status from public.event_log where id = '${eventId}';`).trim();
    expect(status).toBe("pending");
  });

  it("backfill: linha já pendente de um tipo contável não fica órfã — vira done na migration, não é apagada", () => {
    // `INSERT ... RETURNING` puro imprime a tag de comando ("INSERT 0 1") no
    // meio da saída do psql — a CTE + SELECT final devolve só a tupla, igual
    // aos outros casos deste arquivo que usam `select public.emit_event(...)`.
    const out = sql(`
      with nova as (
        insert into public.event_log (organization_id, event_type, entity_kind, status)
          values ('${GOV_ORG}', 'crm.activity_write_failed', 'crm_lead', 'pending')
          returning id
      )
      select id from nova;
    `);
    const eventId = out.trim().split("\n").pop()!.trim();
    // A linha nasceu 'done' pelo gatilho mesmo com status='pending' pedido no
    // INSERT — o gatilho reescreve NEW.status independentemente do valor
    // recebido, exatamente como o backfill da migration já fez pro acúmulo
    // anterior a ela existir.
    const row = sql(`select status from public.event_log where id = '${eventId}';`).trim();
    expect(row).toBe("done");
  });
});
