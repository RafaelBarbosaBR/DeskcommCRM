/**
 * `registrarEventoInterno` é o único lugar que grava um dos 5 eventos —
 * o teste que importa aqui é a idempotência (LEAD/QUALIFIED/PURCHASE não
 * dobram por causa de emissão duplicada de `lead.stage_changed`/`lead.won`)
 * e que todo registro bem-sucedido enfileira o despacho via `emit_event`.
 */
import { describe, expect, it, vi } from "vitest";

import { registrarEventoInterno } from "@/lib/rastreamento/motor/registrar-evento";

const ORG = "11111111-1111-1111-1111-111111111111";
const LEAD = "22222222-2222-2222-2222-222222222222";

function fakeAdmin(opts: { insertError?: { code: string; message: string } | null; insertedId?: string }) {
  const rpcCalls: { name: string; args: unknown }[] = [];
  const admin = {
    from(_tabela: string) {
      return {
        insert: (_vals: Record<string, unknown>) => ({
          select: () => ({
            maybeSingle: async () => {
              if (opts.insertError) return { data: null, error: opts.insertError };
              return { data: { id: opts.insertedId ?? "evt-1" }, error: null };
            },
          }),
        }),
      };
    },
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return { data: null, error: null };
    },
  };
  return { admin, rpcCalls };
}

describe("idempotência de LEAD/QUALIFIED/PURCHASE", () => {
  it("23505 (índice único) vira null silencioso, não erro", async () => {
    const { admin, rpcCalls } = fakeAdmin({ insertError: { code: "23505", message: "duplicate key" } });

    const resultado = await registrarEventoInterno(admin as never, {
      organizationId: ORG,
      tipo: "PURCHASE",
      leadId: LEAD,
    });

    expect(resultado).toBeNull();
    // Evento não gravado de novo: não enfileira despacho de novo.
    expect(rpcCalls).toHaveLength(0);
  });

  it("erro que não é 23505 também devolve null (não derruba o chamador)", async () => {
    const { admin } = fakeAdmin({ insertError: { code: "42501", message: "permission denied" } });

    const resultado = await registrarEventoInterno(admin as never, {
      organizationId: ORG,
      tipo: "LEAD",
      leadId: LEAD,
    });

    expect(resultado).toBeNull();
  });
});

describe("registro bem-sucedido enfileira o despacho", () => {
  it("chama emit_event com o event_type correto e o id do evento interno", async () => {
    const { admin, rpcCalls } = fakeAdmin({ insertedId: "evt-abc" });

    const resultado = await registrarEventoInterno(admin as never, {
      organizationId: ORG,
      tipo: "PAGE_VIEW",
      visitorId: "vis-1",
    });

    expect(resultado).toEqual({ id: "evt-abc" });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe("emit_event");
    expect(rpcCalls[0].args).toMatchObject({
      p_event_type: "tracking.internal_event_created",
      p_entity_kind: "internal_event",
      p_entity_id: "evt-abc",
      p_organization_id: ORG,
    });
  });
});
