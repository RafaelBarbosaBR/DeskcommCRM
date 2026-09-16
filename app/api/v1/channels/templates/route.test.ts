/**
 * POST /api/v1/channels/templates — o sync passa a resolver a credencial POR
 * SESSÃO (`resolveMetaCreds`), com o `.env` como fallback — o mesmo caminho
 * que o envio de mensagem e de modelo já usam (ver `send-template-for-session.
 * test.ts`). Antes esta rota lia só `process.env.META_SYSTEM_USER_TOKEN`:
 * numa instalação com duas organizações conectadas na Meta, sincronizar os
 * templates de QUALQUER uma delas puxava sempre pela conta do ambiente.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { metaSessionForOrg } from "@/lib/channels/meta/session";
import { resolveMetaCreds } from "@/lib/channels/meta/credentials";
import { syncTemplates } from "@/lib/channels/meta/template-sync";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/channels/meta/session", () => ({ metaSessionForOrg: vi.fn() }));
vi.mock("@/lib/channels/meta/credentials", () => ({ resolveMetaCreds: vi.fn() }));
vi.mock("@/lib/channels/meta/template-sync", () => ({ syncTemplates: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));

const ORG = "22222222-2222-4222-8222-222222222222";

function req() {
  return new NextRequest("http://localhost/api/v1/channels/templates", { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u-1" } as never,
    org: { orgId: ORG, name: "Org", role: "admin" } as never,
  });
  vi.mocked(metaSessionForOrg).mockResolvedValue({
    id: "sess-1",
    organizationId: ORG,
    wabaId: "waba-1",
    phoneNumberId: "sessao-pn",
  });
  vi.mocked(syncTemplates).mockResolvedValue({} as never);
});

describe("POST /api/v1/channels/templates — credencial via resolveMetaCreds", () => {
  it("⭐ chama resolveMetaCreds com a organização e o phoneNumberId da sessão", async () => {
    vi.mocked(resolveMetaCreds).mockResolvedValue({
      phoneNumberId: "sessao-pn",
      token: "tok-sessao",
      graphVersion: "v22.0",
      source: "session",
    });

    const { POST } = await import("./route");
    const res = await POST(req());

    expect(res.status).toBe(200);
    expect(resolveMetaCreds).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: ORG, phoneNumberId: "sessao-pn" }),
    );
  });

  it("passa o token e a graphVersion RESOLVIDOS (não o .env cru) para syncTemplates", async () => {
    vi.mocked(resolveMetaCreds).mockResolvedValue({
      phoneNumberId: "sessao-pn",
      token: "tok-sessao",
      graphVersion: "v22.0",
      source: "session",
    });

    const { POST } = await import("./route");
    await POST(req());

    expect(syncTemplates).toHaveBeenCalledWith(
      expect.objectContaining({ token: "tok-sessao", graphVersion: "v22.0" }),
    );
  });

  it("sem credencial (nem sessão, nem .env), responde 400 sem chamar syncTemplates", async () => {
    vi.mocked(resolveMetaCreds).mockResolvedValue(null);

    const { POST } = await import("./route");
    const res = await POST(req());
    const body = (await res.json()) as { error?: { message?: string } };

    expect(res.status).toBe(400);
    expect(body.error?.message).toBe("missing_meta_token");
    expect(syncTemplates).not.toHaveBeenCalled();
  });
});
