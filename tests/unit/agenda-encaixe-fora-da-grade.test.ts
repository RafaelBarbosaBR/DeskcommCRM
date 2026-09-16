/**
 * O ENCAIXE FORA DA GRADE (Onda 4.2) — `exigeHorarioLivre` sempre exigiu que o
 * instante pedido fosse um dos que a grade OFERECE (`consulta.slots`), sem
 * exceção nenhuma por papel. Um atendente que sabe que há um buraco real na
 * agenda (a grade pula de 30 em 30 minutos, e às vezes cabe uma consulta de
 * 15) não tinha como marcar ali — só via SQL direto.
 *
 * O conserto NÃO afrouxa o que protege: o conflito com outro compromisso (ou
 * evento do Google) continua bloqueando, fora da grade ou dentro dela. O que
 * relaxa é só a exigência de bater com um múltiplo publicado — e só para quem
 * é gente de verdade logada (`ctx.actor.type === "user"`) pedindo
 * explicitamente (`fora_da_grade: true`).
 *
 * Estes casos mockam `horariosLivresDaOrg` inteira (como
 * `agenda-emite-atividade.test.ts` já faz) — o que se testa aqui é a DECISÃO
 * de `exigeHorarioLivre`, não o motor de geração de grade, que já tem cobertura
 * própria em `tests/unit/agenda-motor-de-horarios.test.ts` (`horariosLivres`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ResultadoDaConsulta } from "@/lib/agenda/consulta";
import type { HandlerCtx } from "@/lib/api/handlers/types";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => true),
}));

vi.mock("@/lib/agenda/consulta", async (original) => {
  const real = await original<typeof import("@/lib/agenda/consulta")>();
  return { ...real, horariosLivresDaOrg: vi.fn() };
});

const { horariosLivresDaOrg } = await import("@/lib/agenda/consulta");
const { marcarAgendamentoHandler, alterarAgendamentoHandler } = await import(
  "@/app/api/v1/agenda/agendamentos/_handler"
);

const ORG = "aaaaaaaa-1111-4000-8000-00000000000a";
const USUARIO = "bbbbbbbb-1111-4000-8000-00000000000b";
const TIPO = "cccccccc-1111-4000-8000-00000000000c";
const AGENDAMENTO = "ffffffff-1111-4000-8000-00000000000f";

const NA_GRADE = "2026-09-02T13:00:00.000Z"; // um slot que a grade oferece
const FORA_DA_GRADE = "2026-09-02T13:15:00.000Z"; // não é múltiplo do passo da grade

type Linha = Record<string, unknown>;

interface Banco {
  tipo: Linha | null;
  agendamento: Linha | null;
  criado: Linha | null;
  inserido: Record<string, Linha[]>;
}

let banco: Banco;
/** Se `conflitaComOcupado` deve dizer que HÁ conflito — controlado por caso. */
let haConflito: boolean;

function consultaComUmSlot(): ResultadoDaConsulta {
  return {
    ok: true,
    slots: [{ inicio: new Date(NA_GRADE), fim: new Date(new Date(NA_GRADE).getTime() + 30 * 60_000) }],
    fusoDaRegra: "America/Sao_Paulo",
    publicouHorarios: true,
    fusoSuposto: false,
    fontesDefasadas: [],
    agendaExternaNuncaLida: false,
    googleCoberturaParcial: false,
    conflitaComOcupado: () => haConflito,
  };
}

function dadoDaTabela(tabela: string): unknown {
  switch (tabela) {
    case "calendar_event_types":
      return banco.tipo;
    case "calendar_appointments":
      return banco.agendamento;
    default:
      return null;
  }
}

function cliente(): SupabaseClient {
  const leitura = (tabela: string) => {
    const cadeia: Record<string, unknown> = {};
    for (const m of ["eq", "neq", "in", "is", "not", "or", "gte", "lte", "order", "limit"]) {
      cadeia[m] = () => cadeia;
    }
    const resposta = () => ({ data: dadoDaTabela(tabela), error: null });
    cadeia.maybeSingle = async () => resposta();
    cadeia.single = async () => resposta();
    cadeia.then = (r: (v: unknown) => unknown) => r(resposta());
    return cadeia;
  };

  return {
    from: (tabela: string) => ({
      select: () => leitura(tabela),
      insert: (linha: Linha) => {
        (banco.inserido[tabela] ??= []).push(linha);
        const resposta = { data: banco.criado ?? linha, error: null };
        return {
          select: () => ({ single: async () => resposta, maybeSingle: async () => resposta }),
          then: (r: (v: unknown) => unknown) => r(resposta),
        };
      },
      update: (patch: Linha) => {
        const cadeia: Record<string, unknown> = {};
        const resposta = () => ({ data: { ...(banco.agendamento ?? {}), ...patch }, error: null });
        for (const m of ["eq", "in"]) cadeia[m] = () => cadeia;
        cadeia.select = () => cadeia;
        cadeia.single = async () => resposta();
        cadeia.then = (r: (v: unknown) => unknown) => r(resposta());
        return cadeia;
      },
    }),
    rpc: async (fn: string, args: Linha) => {
      if (fn === "fn_appointment_change") {
        return { data: { ...banco.agendamento, ...(args.p_patch as Linha), revision: 2 }, error: null };
      }
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;
}

function ctxComoUser(): HandlerCtx {
  return { organization_id: ORG, actor: { type: "user", id: USUARIO }, requestId: "req-1" };
}

function ctxComoAgenteDeIA(): HandlerCtx {
  return { organization_id: ORG, actor: { type: "ai_agent", id: "run-1", role: "agent" }, requestId: "req-1" };
}

beforeEach(() => {
  vi.clearAllMocks();
  haConflito = false;
  banco = {
    tipo: {
      id: TIPO,
      name: "Consulta",
      is_active: true,
      duration_minutes: 30,
      default_owner_user_id: USUARIO,
      requires_confirmation: false,
      location_kind: "in_person",
      location_details: null,
    },
    agendamento: {
      id: AGENDAMENTO,
      event_type_id: TIPO,
      owner_user_id: USUARIO,
      contact_id: null,
      starts_at: NA_GRADE,
      status: "confirmed",
      time_zone: "America/Sao_Paulo",
    },
    criado: {
      id: AGENDAMENTO,
      starts_at: FORA_DA_GRADE,
      ends_at: "2026-09-02T13:45:00.000Z",
      status: "confirmed",
      time_zone: "America/Sao_Paulo",
    },
    inserido: {},
  };
  vi.mocked(horariosLivresDaOrg).mockImplementation(async () => consultaComUmSlot());
});

describe("marcar fora da grade", () => {
  it("⭐ papel autorizado (user + fora_da_grade) encaixa um instante que a grade não oferece", async () => {
    const criado = await marcarAgendamentoHandler(cliente(), ctxComoUser(), {
      event_type_id: TIPO,
      starts_at: FORA_DA_GRADE,
      fora_da_grade: true,
    });

    expect(criado.id).toBe(AGENDAMENTO);
    expect(banco.inserido["calendar_appointments"]).toHaveLength(1);
  });

  it("⭐ conflito REAL ainda bloqueia, mesmo fora da grade e mesmo autorizado", async () => {
    haConflito = true;

    await expect(
      marcarAgendamentoHandler(cliente(), ctxComoUser(), {
        event_type_id: TIPO,
        starts_at: FORA_DA_GRADE,
        fora_da_grade: true,
      }),
    ).rejects.toMatchObject({ status: 409, code: "agenda_horario_conflita" });

    expect(
      banco.inserido["calendar_appointments"],
      "o conflito não impediu a escrita — a proteção mais importante do item furou",
    ).toBeUndefined();
  });

  it("⭐ papel NÃO autorizado (agente de IA) continua preso à grade mesmo pedindo fora_da_grade", async () => {
    // O campo chega no payload (uma tool ou um cliente HTTP malicioso poderia
    // mandar), mas o handler decide pelo ATOR, não pelo que foi pedido.
    await expect(
      marcarAgendamentoHandler(cliente(), ctxComoAgenteDeIA(), {
        event_type_id: TIPO,
        starts_at: FORA_DA_GRADE,
        fora_da_grade: true,
      }),
    ).rejects.toMatchObject({ status: 422, code: "agenda_horario_indisponivel" });
  });

  it("usuário SEM pedir fora_da_grade continua preso à grade (comportamento de sempre)", async () => {
    await expect(
      marcarAgendamentoHandler(cliente(), ctxComoUser(), {
        event_type_id: TIPO,
        starts_at: FORA_DA_GRADE,
        // fora_da_grade ausente
      }),
    ).rejects.toMatchObject({ status: 422, code: "agenda_horario_indisponivel" });
  });

  it("um instante QUE JÁ BATE na grade continua funcionando igual, com ou sem o campo", async () => {
    const criado = await marcarAgendamentoHandler(cliente(), ctxComoUser(), {
      event_type_id: TIPO,
      starts_at: NA_GRADE,
    });
    expect(criado.id).toBe(AGENDAMENTO);
  });
});

describe("remarcar fora da grade — o SEGUNDO call site de exigeHorarioLivre", () => {
  it("papel autorizado remarca para um instante fora da grade", async () => {
    const salvo = await alterarAgendamentoHandler(cliente(), ctxComoUser(), {
      id: AGENDAMENTO,
      starts_at: FORA_DA_GRADE,
      fora_da_grade: true,
    });
    expect(salvo.starts_at).toBe(new Date(FORA_DA_GRADE).toISOString());
  });

  it("sem o campo, remarcar para fora da grade continua recusado", async () => {
    await expect(
      alterarAgendamentoHandler(cliente(), ctxComoUser(), {
        id: AGENDAMENTO,
        starts_at: FORA_DA_GRADE,
      }),
    ).rejects.toMatchObject({ status: 422, code: "agenda_horario_indisponivel" });
  });
});
