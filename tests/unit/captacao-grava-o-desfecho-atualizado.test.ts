// @vitest-environment node
//
// O DESFECHO `atualizado` É GRAVADO COMO ELE É (#2316, migration 0683).
//
// Enquanto o CHECK de `webhook_lead_captures.outcome` não conhecia o valor novo,
// `registrarCaptacao` tinha uma PONTE: um `23514` vindo do CHECK repetia a
// inserção como `duplicado` para a linha não sumir da tela "Leads recebidos".
// A migration 0683 alargou o vocabulário e a ponte saiu — o que estes casos
// fixam é que a captação grava UMA linha, com o desfecho verdadeiro, e continua
// cumprindo a promessa escrita no cabeçalho do módulo: NUNCA LANÇAR.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  linhas: [] as Array<Record<string, unknown>>,
  /** one-shot: devolvido só na primeira inserção que o receber. */
  erro: null as { code: string; message: string } | null,
}));

import { registrarCaptacao } from "@/lib/webhooks/captacao";

type AdminDoTeste = Parameters<typeof registrarCaptacao>[0];

/** O cliente mínimo que `registrarCaptacao` usa: um `from().insert()`. */
function cliente(): AdminDoTeste {
  return {
    from: () => ({
      insert: async (linha: Record<string, unknown>) => {
        h.linhas.push(linha);
        const erro = h.erro;
        h.erro = null;
        return { error: erro };
      },
    }),
  } as unknown as AdminDoTeste;
}

const CAPTACAO = {
  organizationId: "org-1",
  webhookSourceId: "fonte-1",
  sourceName: "Integração do diagnóstico",
  leadId: "lead-1",
  contactId: "contato-1",
} as const;

beforeEach(() => {
  h.linhas.length = 0;
  h.erro = null;
});

describe("o desfecho atualizado chega ao banco pelo caminho direto (#2316)", () => {
  it("⭐ UMA inserção, já com `atualizado` — não há mais ponte para `duplicado`", async () => {
    await registrarCaptacao(cliente(), { ...CAPTACAO, outcome: "atualizado" });

    expect(h.linhas.map((l) => l.outcome)).toEqual(["atualizado"]);
    expect(h.linhas[0]).toMatchObject({ lead_id: "lead-1", contact_id: "contato-1" });
  });

  it("os outros desfechos seguem numa inserção só, com o vínculo do contato", async () => {
    for (const outcome of ["criado", "duplicado", "recusado"] as const) {
      h.linhas.length = 0;
      await registrarCaptacao(cliente(), { ...CAPTACAO, outcome });
      expect(h.linhas.map((l) => l.outcome)).toEqual([outcome]);
      expect(h.linhas[0]).toMatchObject({ contact_id: "contato-1" });
    }
  });

  it("recusa do banco não lança e não é reescrita com outro desfecho", async () => {
    h.erro = { code: "42501", message: "permission denied" };

    await expect(
      registrarCaptacao(cliente(), { ...CAPTACAO, outcome: "atualizado" }),
    ).resolves.toBeUndefined();

    expect(h.linhas.map((l) => l.outcome), "sem ponte: uma linha só").toEqual(["atualizado"]);
  });

  it("violação de CHECK (23514) também não vira segunda linha nem exception", async () => {
    // Estado que só existe se o `update.sh` de um clone ficou para trás: o
    // vocabulário do TypeScript é mais novo que o do banco. A linha não pode
    // sumir, e a captação não pode derrubar o webhook por causa do histórico.
    h.erro = {
      code: "23514",
      message:
        'new row for relation "webhook_lead_captures" violates check constraint "webhook_lead_captures_outcome_check"',
    };

    await expect(
      registrarCaptacao(cliente(), { ...CAPTACAO, outcome: "atualizado" }),
    ).resolves.toBeUndefined();

    expect(h.linhas.map((l) => l.outcome)).toEqual(["atualizado"]);
  });
});
