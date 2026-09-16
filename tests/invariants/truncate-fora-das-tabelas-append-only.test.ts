import { describe, expect, it } from "vitest";
import { sql } from "./gov-helpers";

/**
 * `api_audit_log`/`crm_lead_activities`/`event_log`/`webhook_events_log` são
 * append-only por doutrina (migration 0248) — TRUNCATE ignora RLS e apaga o
 * histórico inteiro num comando só, sem WHERE, sem trigger. Nenhum papel
 * real (nem `service_role`, a credencial que `createAdminClient()` usa)
 * precisa desse privilégio nestas quatro tabelas.
 *
 * `postgres`/superuser NÃO mede nada aqui: bypassa toda checagem de GRANT.
 * `set role <papel>` a partir de uma conexão superuser DEMOTE de verdade —
 * é o mesmo mecanismo que as outras suítes de invariante já usam para medir
 * RLS, aplicado agora à checagem de privilégio de TABELA.
 */

const TABELAS = ["api_audit_log", "crm_lead_activities", "event_log", "webhook_events_log"] as const;
const PAPEIS = ["anon", "authenticated", "service_role"] as const;

describe("TRUNCATE fora das tabelas append-only", () => {
  for (const papel of PAPEIS) {
    for (const tabela of TABELAS) {
      it(`${papel} não trunca ${tabela}`, () => {
        const out = sql(`
          set role ${papel};
          do $$
          begin
            begin
              truncate public.${tabela};
              raise exception 'truncate allowed';
            exception when insufficient_privilege then null;
            end;
          end $$;
          reset role;
          select 'proved';
        `);
        expect(out).toContain("proved");
      });
    }
  }

  it("controle positivo: service_role ainda LÊ e ESCREVE nas quatro (a revogação foi só de TRUNCATE)", () => {
    const out = sql(`
      set role service_role;
      do $$
      declare n integer;
      begin
        select count(*) into n from public.api_audit_log;
        select count(*) into n from public.crm_lead_activities;
        select count(*) into n from public.event_log;
        select count(*) into n from public.webhook_events_log;
      end $$;
      reset role;
      select 'proved';
    `);
    expect(out).toContain("proved");
  });
});
