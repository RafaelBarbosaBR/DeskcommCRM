/**
 * REVOGAR IMPEDE O ACEITE MESMO COM O LINK AINDA DENTRO DA VALIDADE.
 *
 * `verifyInviteToken` (chamado por quem invoca `aplicarConvite`) só confere
 * assinatura e `exp` — nenhum dos dois muda quando alguém revoga o convite
 * pela tela DEPOIS de emiti-lo. `team_invites.status` (migration 0245) é a
 * única fonte que sabe disso, e o que se prende aqui é que a checagem
 * acontece ANTES de `fn_accept_team_invite` rodar — nunca depois, o que
 * criaria a janela em que o vínculo já foi gravado e só then a recusa chega.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/lib/supabase/cookie-secure", () => ({ cookieSecure: () => true }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { cookies } from "next/headers";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { aplicarConvite } from "./aplicar-convite";
import type { InvitePayload } from "./invite-token";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const INVITE_ID = "33333333-3333-4333-8333-333333333333";
const MEMBERSHIP_ID = "44444444-4444-4444-8444-444444444444";

const PAYLOAD: InvitePayload = {
  invite_id: INVITE_ID,
  email: "novo@example.com",
  organization_id: ORG,
  role: "agent",
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
  invited_by: "55555555-5555-4555-8555-555555555555",
};

interface Estado {
  statusDoConvite: string | undefined; // undefined = sem linha nenhuma
  rpcResultado: { data: unknown; error: { code?: string; message?: string } | null };
}

function makeAdmin(estado: Estado) {
  const updates: Array<{ valores: Record<string, unknown>; filtros: Record<string, unknown> }> = [];
  const rpc = vi.fn(async () => estado.rpcResultado);

  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => {
      expect(tabela).toBe("team_invites");
      const filtros: Record<string, unknown> = {};
      const api = {
        select: () => api,
        eq: (col: string, val: unknown) => {
          filtros[col] = val;
          return api;
        },
        neq: () => api,
        maybeSingle: async () => ({
          data: estado.statusDoConvite === undefined ? null : { status: estado.statusDoConvite },
          error: null,
        }),
        update: (valores: Record<string, unknown>) => {
          updates.push({ valores, filtros: { ...filtros } });
          return {
            eq: () => ({
              neq: async () => ({ error: null }),
            }),
          };
        },
      };
      return api;
    },
    rpc,
  } as unknown as ReturnType<typeof createAdminClient>);

  return { updates, rpc };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(cookies).mockResolvedValue({ set: vi.fn() } as never);
});

describe("aplicarConvite — convite revogado", () => {
  it("recusa e NÃO chama fn_accept_team_invite", async () => {
    const { rpc } = makeAdmin({ statusDoConvite: "revoked", rpcResultado: { data: null, error: null } });

    const r = await aplicarConvite({ userId: USER, payload: PAYLOAD });

    expect(r).toEqual({ ok: false, motivo: "invalid_or_expired" });
    expect(rpc).not.toHaveBeenCalled();
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});

describe("aplicarConvite — convite sem linha em team_invites (anterior à migration 0245)", () => {
  it("segue normalmente — ausência não é recusa", async () => {
    makeAdmin({
      statusDoConvite: undefined,
      rpcResultado: { data: { id: MEMBERSHIP_ID, changed: true }, error: null },
    });

    const r = await aplicarConvite({ userId: USER, payload: PAYLOAD });

    expect(r).toEqual({ ok: true, membershipId: MEMBERSHIP_ID, mudou: true });
  });
});

describe("aplicarConvite — convite pending, aceite normal", () => {
  it("aceita, audita e marca team_invites como accepted", async () => {
    const { updates } = makeAdmin({
      statusDoConvite: "pending",
      rpcResultado: { data: { id: MEMBERSHIP_ID, changed: true }, error: null },
    });

    const r = await aplicarConvite({ userId: USER, payload: PAYLOAD });

    expect(r).toEqual({ ok: true, membershipId: MEMBERSHIP_ID, mudou: true });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "member.accepted", resourceId: MEMBERSHIP_ID }),
    );
    const gravouAceite = updates.some((u) => u.valores.status === "accepted");
    expect(gravouAceite, "não marcou team_invites como aceito").toBe(true);
  });

  it("reaceite (changed:false) AINDA marca team_invites — sem isso a linha fica 'Pendente' pra sempre", async () => {
    const { updates } = makeAdmin({
      statusDoConvite: "pending",
      rpcResultado: { data: { id: MEMBERSHIP_ID, changed: false }, error: null },
    });

    const r = await aplicarConvite({ userId: USER, payload: PAYLOAD });

    expect(r.ok).toBe(true);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
    const gravouAceite = updates.some((u) => u.valores.status === "accepted");
    expect(gravouAceite).toBe(true);
  });
});

describe("aplicarConvite — recusa da RPC", () => {
  it("42501 (revogado/posterior à revogação) vira invalid_or_expired", async () => {
    makeAdmin({
      statusDoConvite: "pending",
      rpcResultado: { data: null, error: { code: "42501", message: "recusado" } },
    });

    const r = await aplicarConvite({ userId: USER, payload: PAYLOAD });
    expect(r).toEqual({ ok: false, motivo: "invalid_or_expired" });
  });

  it("outro código vira internal_error", async () => {
    makeAdmin({
      statusDoConvite: "pending",
      rpcResultado: { data: null, error: { code: "08000", message: "conexão caiu" } },
    });

    const r = await aplicarConvite({ userId: USER, payload: PAYLOAD });
    expect(r).toEqual({ ok: false, motivo: "internal_error" });
  });
});
