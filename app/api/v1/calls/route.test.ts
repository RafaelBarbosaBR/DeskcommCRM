import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { Api4comError } from "@/lib/channels/api4com/client";
import type * as Api4comClientModule from "@/lib/channels/api4com/client";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/voip/ariClient", () => ({ originateCall: vi.fn(async () => ({ id: "asterisk-chan-1" })) }));
vi.mock("@/lib/channels/api4com/credentials", () => ({
  api4comCredsForOrg: vi.fn(async () => null),
  api4comExtensionForUser: vi.fn(async () => null),
}));
vi.mock("@/lib/channels/api4com/client", async (importOriginal) => {
  const real = await importOriginal<typeof Api4comClientModule>();
  return { ...real, api4comClickToCall: vi.fn(async () => ({ id: "api4com-call-1" })) };
});

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

type Row = Record<string, unknown>;

/** Fake mínimo: só os caminhos que o POST de /api/v1/calls exercita. */
function fakeDb(seed: { trunk?: Row | null } = {}) {
  const voiceCalls: Row[] = [];

  function from(table: string) {
    if (table === "voice_calls") {
      const chain = {
        insert: (row: Row) => {
          const saved = { id: `vc-${voiceCalls.length + 1}`, ...row };
          voiceCalls.push(saved);
          return {
            select: () => ({
              single: async () => ({ data: saved, error: null }),
            }),
          };
        },
        update: (patch: Row) => ({
          eq: (_col: string, id: string) => {
            const row = voiceCalls.find((r) => r.id === id);
            if (row) Object.assign(row, patch);
            return Promise.resolve({ data: row ?? null, error: null });
          },
        }),
      };
      return chain;
    }
    if (table === "voip_trunk_settings") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: seed.trunk ?? null, error: null }),
          }),
        }),
      };
    }
    if (table === "contacts" || table === "crm_leads") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      };
    }
    throw new Error(`fakeDb: tabela não esperada no teste: ${table}`);
  }

  return { from: vi.fn(from), __voiceCalls: voiceCalls };
}

function request(body: string): NextRequest {
  return new NextRequest("http://localhost/api/v1/calls", {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID, idioma: "pt-BR" },
    org: { orgId: ORG_ID },
  } as never);
});

describe("POST /api/v1/calls — modo humano escolhe o provedor", () => {
  it("com api4com conectada e ramal mapeado, disca pela api4com (não toca o trunk SIP)", async () => {
    const { api4comCredsForOrg, api4comExtensionForUser } = await import("@/lib/channels/api4com/credentials");
    const { api4comClickToCall } = await import("@/lib/channels/api4com/client");
    const { originateCall } = await import("@/lib/voip/ariClient");
    vi.mocked(api4comCredsForOrg).mockResolvedValue({ domain: "org.api4com.com", accessToken: "tok" });
    vi.mocked(api4comExtensionForUser).mockResolvedValue("1001");
    vi.mocked(createClient).mockResolvedValue(fakeDb() as never);

    const { POST } = await import("./route");
    const response = await POST(request(JSON.stringify({ toNumber: "+5511999998888", mode: "human" })));

    expect(response.status).toBe(201);
    expect(api4comClickToCall).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({ extension: "1001", caller: "1001", called: "+5511999998888" }),
    );
    expect(originateCall).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.data.providerCallId).toBe("api4com-call-1");
  });

  it("api4com conectada, mas ESTE usuário sem ramal mapeado — cai no trunk SIP, não erra", async () => {
    const { api4comCredsForOrg, api4comExtensionForUser } = await import("@/lib/channels/api4com/credentials");
    const { api4comClickToCall } = await import("@/lib/channels/api4com/client");
    const { originateCall } = await import("@/lib/voip/ariClient");
    vi.mocked(api4comCredsForOrg).mockResolvedValue({ domain: "org.api4com.com", accessToken: "tok" });
    vi.mocked(api4comExtensionForUser).mockResolvedValue(null);
    vi.mocked(createClient).mockResolvedValue(
      fakeDb({ trunk: { endpoint_name: "org-x-trunk", is_active: true } }) as never,
    );

    const { POST } = await import("./route");
    const response = await POST(request(JSON.stringify({ toNumber: "+5511999998888", mode: "human" })));

    expect(response.status).toBe(201);
    expect(originateCall).toHaveBeenCalled();
    expect(api4comClickToCall).not.toHaveBeenCalled();
  });

  it("sem api4com configurada, modo humano cai no trunk SIP de sempre", async () => {
    const { api4comCredsForOrg } = await import("@/lib/channels/api4com/credentials");
    const { api4comClickToCall } = await import("@/lib/channels/api4com/client");
    const { originateCall } = await import("@/lib/voip/ariClient");
    vi.mocked(api4comCredsForOrg).mockResolvedValue(null);
    vi.mocked(createClient).mockResolvedValue(
      fakeDb({ trunk: { endpoint_name: "org-x-trunk", is_active: true } }) as never,
    );

    const { POST } = await import("./route");
    const response = await POST(request(JSON.stringify({ toNumber: "+5511999998888", mode: "human" })));

    expect(response.status).toBe(201);
    expect(originateCall).toHaveBeenCalled();
    expect(api4comClickToCall).not.toHaveBeenCalled();
  });

  it("modo IA NUNCA passa pela api4com, mesmo com ela configurada", async () => {
    const { api4comCredsForOrg } = await import("@/lib/channels/api4com/credentials");
    const { api4comClickToCall } = await import("@/lib/channels/api4com/client");
    const { originateCall } = await import("@/lib/voip/ariClient");
    vi.mocked(api4comCredsForOrg).mockResolvedValue({ domain: "org.api4com.com", accessToken: "tok" });
    vi.mocked(createClient).mockResolvedValue(
      fakeDb({ trunk: { endpoint_name: "org-x-trunk", is_active: true } }) as never,
    );

    const { POST } = await import("./route");
    const response = await POST(request(JSON.stringify({ toNumber: "+5511999998888", mode: "ai" })));

    expect(response.status).toBe(201);
    expect(originateCall).toHaveBeenCalled();
    expect(api4comClickToCall).not.toHaveBeenCalled();
    expect(api4comCredsForOrg).not.toHaveBeenCalled();
  });

  it("falha da api4com (ex.: ramal não encontrado) marca a chamada como failed e devolve 422, sem cair no trunk", async () => {
    const { api4comCredsForOrg, api4comExtensionForUser } = await import("@/lib/channels/api4com/credentials");
    const { api4comClickToCall } = await import("@/lib/channels/api4com/client");
    const { originateCall } = await import("@/lib/voip/ariClient");
    vi.mocked(api4comCredsForOrg).mockResolvedValue({ domain: "org.api4com.com", accessToken: "tok" });
    vi.mocked(api4comExtensionForUser).mockResolvedValue("1001");
    vi.mocked(api4comClickToCall).mockRejectedValue(new Api4comError(404, "EXTENSION_NOT_FOUND"));
    const db = fakeDb();
    vi.mocked(createClient).mockResolvedValue(db as never);

    const { POST } = await import("./route");
    const response = await POST(request(JSON.stringify({ toNumber: "+5511999998888", mode: "human" })));

    expect(response.status).toBe(422);
    expect(originateCall).not.toHaveBeenCalled();
    expect(db.__voiceCalls[0]).toMatchObject({ status: "ended", end_reason: "failed" });
  });
});
