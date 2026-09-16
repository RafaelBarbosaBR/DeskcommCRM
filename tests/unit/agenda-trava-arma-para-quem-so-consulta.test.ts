/**
 * A TRAVA DE AGENDA (gate + bloco de sistema) ARMAVA SÓ PARA QUEM MARCA.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * `agenda.active` (que arma o `agendaStallGate` em `before-send.ts`) e a
 * escolha de injetar o `AGENDA_SYSTEM_BLOCK` dependiam só de
 * `toolIds.includes('crm_book_appointment')`. Um agente configurado para SÓ
 * CONSULTAR (`crm_find_free_slots`/`crm_list_appointments`, sem nenhuma tool
 * que cria ou muda reserva) nunca armava nada — nem a instrução de sistema,
 * nem a rede determinística. Ele podia alucinar "está confirmado" sem NENHUMA
 * das duas camadas de defesa pegando.
 *
 * O conserto tem duas partes:
 *   1. `agendaAtiva` (novo, `agenda-tools.ts`) — QUALQUER tool de agenda arma,
 *      não só a de marcar. Compartilhado por `inbound-turn.ts` E `preview.ts`.
 *   2. `agendaSystemBlock` passa a MONTAR o texto pelas tools que o agente TEM
 *      — nomear `crm_book_appointment` para quem não tem a tool ensina um
 *      caminho que não existe.
 */
import { describe, expect, it } from "vitest";

import { agendaAtiva, AGENDA_TOOL_IDS } from "@/lib/agent-engine/agent/agenda-tools";
import { agendaSystemBlock } from "@/lib/agent-engine/agent/inbound-turn";

describe("agendaAtiva — qualquer tool de agenda arma, não só a de marcar", () => {
  it("⭐ só crm_find_free_slots (consulta pura) já ativa", () => {
    expect(agendaAtiva(["crm_find_free_slots"])).toBe(true);
  });

  it("só crm_list_appointments também ativa", () => {
    expect(agendaAtiva(["crm_list_appointments"])).toBe(true);
  });

  it("crm_book_appointment continua ativando (caso original)", () => {
    expect(agendaAtiva(["crm_book_appointment"])).toBe(true);
  });

  it("nenhuma tool de agenda no toolIds: desativado", () => {
    expect(agendaAtiva(["send_message", "crm_move_lead_stage"])).toBe(false);
  });

  it("toolIds vazio: desativado", () => {
    expect(agendaAtiva([])).toBe(false);
  });

  it("as 5 tools de agenda conhecidas estão no catálogo", () => {
    expect([...AGENDA_TOOL_IDS].sort()).toEqual(
      [
        "crm_book_appointment",
        "crm_cancel_appointment",
        "crm_find_free_slots",
        "crm_list_appointments",
        "crm_reschedule_appointment",
      ].sort(),
    );
  });
});

describe("agendaSystemBlock — só nomeia as tools que o agente TEM", () => {
  it("⭐ agente só-consulta (find_free_slots) não vê crm_book_appointment no texto", () => {
    const texto = agendaSystemBlock(["crm_find_free_slots"]);
    expect(texto, "nomeou uma tool que o agente não tem").not.toContain("crm_book_appointment");
    expect(texto, "nomeou uma tool que o agente não tem").not.toContain(
      "crm_reschedule_appointment",
    );
    expect(texto).toContain("crm_find_free_slots");
    expect(texto).toMatch(/você só consulta|só CONSULTA/i);
  });

  it("agente só-consulta (list_appointments) menciona list, não find", () => {
    const texto = agendaSystemBlock(["crm_list_appointments"]);
    expect(texto).toContain("crm_list_appointments");
    expect(texto).not.toContain("crm_find_free_slots");
    expect(texto).not.toContain("crm_book_appointment");
  });

  it("agente com crm_book_appointment mas SEM crm_reschedule_appointment não menciona reschedule", () => {
    const texto = agendaSystemBlock(["crm_find_free_slots", "crm_book_appointment"]);
    expect(texto).toContain("crm_book_appointment");
    expect(texto).not.toContain("crm_reschedule_appointment");
  });

  it("agente com as duas (book + reschedule) menciona as duas — texto original preservado", () => {
    const texto = agendaSystemBlock([
      "crm_find_free_slots",
      "crm_book_appointment",
      "crm_reschedule_appointment",
    ]);
    expect(texto).toContain("crm_book_appointment (ou crm_reschedule_appointment, para remarcação)");
    // A regra hardenizada pelos três incidentes documentados no arquivo precisa
    // sobreviver INTACTA para quem tem a tool de marcar.
    expect(texto).toContain("NUNCA diga \"confirmado\", \"está marcado\"");
    expect(texto).toContain("Fernando");
  });

  it("tier de quem marca (com book) também proíbe confirmação categórica sem checar", () => {
    const texto = agendaSystemBlock(["crm_book_appointment"]);
    expect(texto).toMatch(/nunca confirme sem checar/i);
  });

  it("tier de quem só consulta proíbe confirmar mesmo sem citar a mecânica de checar tool", () => {
    const texto = agendaSystemBlock(["crm_find_free_slots", "crm_list_appointments"]);
    expect(texto).toMatch(/NUNCA diga.*confirmado/i);
    expect(texto).toMatch(/não tem como fazer isso acontecer/);
  });
});
