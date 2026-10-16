import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const LEAD_ID = "33333333-3333-4333-8333-333333333333";
const CONTACT_ID = "44444444-4444-4444-8444-444444444444";

/** `select("id, contact_id").eq(...).eq(...).maybeSingle()` — só esta forma. */
function fakeDb(lead: { id: string; contact_id: string | null } | null) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: lead, error: null }),
  };
  return { from: vi.fn(() => chain) };
}

function request(body: string): NextRequest {
  return new NextRequest(`http://localhost/api/v1/leads/${LEAD_ID}/notes`, {
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

describe("POST /api/v1/leads/[id]/notes", () => {
  it("grava a atividade note com o texto do corpo e o ator do usuário logado", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeDb({ id: LEAD_ID, contact_id: CONTACT_ID }) as never,
    );
    const { POST } = await import("./route");

    const response = await POST(
      request(JSON.stringify({ text: "Cliente pediu desconto de 10%." })),
      { params: Promise.resolve({ id: LEAD_ID }) },
    );

    expect(response.status).toBe(201);
    expect(emitLeadActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG_ID,
        leadId: LEAD_ID,
        contactId: CONTACT_ID,
        type: "note",
        actor: { type: "user", id: USER_ID },
        reason: "Cliente pediu desconto de 10%.",
      }),
    );
  });

  it("recusa texto vazio antes de tocar o banco", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeDb({ id: LEAD_ID, contact_id: null }) as never);
    const { POST } = await import("./route");

    const response = await POST(request(JSON.stringify({ text: "" })), {
      params: Promise.resolve({ id: LEAD_ID }),
    });

    expect(response.status).toBe(422);
    expect(emitLeadActivity).not.toHaveBeenCalled();
  });

  it("negócio de outra organização (ou inexistente) dá 404, nunca grava", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeDb(null) as never);
    const { POST } = await import("./route");

    const response = await POST(request(JSON.stringify({ text: "qualquer coisa" })), {
      params: Promise.resolve({ id: LEAD_ID }),
    });

    expect(response.status).toBe(404);
    expect(emitLeadActivity).not.toHaveBeenCalled();
  });

  it("falha ao gravar devolve 500 — o comentário NÃO pode desaparecer em silêncio", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeDb({ id: LEAD_ID, contact_id: CONTACT_ID }) as never,
    );
    vi.mocked(emitLeadActivity).mockResolvedValueOnce({ ok: false, error: "boom" });
    const { POST } = await import("./route");

    const response = await POST(request(JSON.stringify({ text: "nota qualquer" })), {
      params: Promise.resolve({ id: LEAD_ID }),
    });

    expect(response.status).toBe(500);
  });
});
