import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { POST } from "./route";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

/**
 * DESMARCAR O EXEMPLO TIRA OS TRECHOS JÁ APRENDIDOS (#3042, migration 0688).
 *
 * Desmarcar chama `fn_conversa_remove_trechos_do_rag` com o org da SESSÃO e
 * leva a contagem para a resposta e para a auditoria; marcar não chama.
 *
 * ─── SABOTAGEM (linha para reverter: `route.ts`) ────────────────────────────
 * - Tirar a chamada da RPC no ramo enabled=false: cai "desmarcar remove".
 * - Chamar também ao marcar: cai "marcar não remove".
 * - Passar outro org que não o da sessão: cai "desmarcar remove" (p_org).
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";

let chamadasRpc: Array<{ funcao: string; args: Record<string, unknown> }> = [];

function fakeUserClient() {
  const q = {
    select: () => q,
    update: () => q,
    eq: () => q,
    maybeSingle: async () => ({ data: { id: CONVERSA, usable_for_rag: true }, error: null }),
  };
  return { from: () => q };
}

const enviar = (enabled: boolean) =>
  POST(
    new NextRequest(`http://localhost/api/v1/conversations/${CONVERSA}/usable-for-rag`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: CONVERSA }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  chamadasRpc = [];
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1", idioma: "pt-BR" },
    org: { orgId: ORG, role: "agent" },
  } as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(createClient).mockResolvedValue(
    fakeUserClient() as unknown as Awaited<ReturnType<typeof createClient>>,
  );
  vi.mocked(createAdminClient).mockReturnValue({
    rpc: async (funcao: string, args: Record<string, unknown>) => {
      chamadasRpc.push({ funcao, args });
      return { data: 3, error: null };
    },
  } as unknown as ReturnType<typeof createAdminClient>);
  vi.mocked(audit).mockResolvedValue(undefined);
});

describe("usable-for-rag: desmarcar tira os trechos já aprendidos", () => {
  it("desmarcar remove, com o org da sessão, e leva a contagem à resposta e à auditoria", async () => {
    const resposta = await enviar(false);
    expect(resposta.status).toBe(200);
    expect(chamadasRpc).toEqual([
      { funcao: "fn_conversa_remove_trechos_do_rag", args: { p_org: ORG, p_conversation: CONVERSA } },
    ]);
    const corpo = (await resposta.json()) as { data: { trechos_removidos?: number } };
    expect(corpo.data.trechos_removidos).toBe(3);
    expect(vi.mocked(audit).mock.calls[0]?.[0]?.metadata).toMatchObject({
      enabled: false,
      trechos_removidos: 3,
    });
  });

  it("marcar não remove nada", async () => {
    const resposta = await enviar(true);
    expect(resposta.status).toBe(200);
    expect(chamadasRpc).toEqual([]);
    expect(vi.mocked(audit).mock.calls[0]?.[0]?.metadata).not.toHaveProperty("trechos_removidos");
  });

  it("falha da remoção vira 500, não um 200 que promete o que não fez", async () => {
    vi.mocked(createAdminClient).mockReturnValue({
      rpc: async () => ({ data: null, error: { message: "boom" } }),
    } as unknown as ReturnType<typeof createAdminClient>);
    const resposta = await enviar(false);
    expect(resposta.status).toBe(500);
    expect(audit).not.toHaveBeenCalled();
  });
});
