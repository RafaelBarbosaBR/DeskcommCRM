/**
 * REENVIAR E REVOGAR — os dois atos que a aba "Convites" precisa (migration
 * 0245). O que se prende:
 *
 *  1. Os dois exigem `admin` — mesmo papel que já emite convite hoje.
 *  2. Reenviar recusa `accepted`/`revoked` (desfechos definitivos que um
 *     reenvio não desfaz) mas aceita `pending` mesmo vencido — é o caso
 *     comum que a rota existe para resolver.
 *  3. Revogar é IDEMPOTENTE: revogar duas vezes não é erro.
 *  4. Revogar audita `member.invite_revoked`, reenviar audita
 *     `member.invite_resent` — os DOIS namespaces `member.*`, não um
 *     namespace `invite.*` à parte (mesma família de `member.reactivated`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/email/resend", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: async () => ({ nome: "Org" }) }));
vi.mock("@/lib/email/templates/invite", () => ({
  buildInviteEmail: () => ({ subject: "x", html: "x", text: "x" }),
}));

import { audit } from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const INVITE = "33333333-3333-4333-8333-333333333333";

function authOk(role: "admin" | "manager" = "admin"): void {
  const user: AuthUser = {
    id: USER,
    email: "admin@example.com",
    full_name: "Admin",
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG, name: "Org", role },
  } as never);
}

function makeDb(linha: Record<string, unknown> | null) {
  const updates: Array<{ valores: Record<string, unknown> }> = [];
  vi.mocked(createClient).mockResolvedValue({
    from: () => {
      const api = {
        select: () => api,
        eq: () => api,
        maybeSingle: async () => ({ data: linha, error: null }),
        update: (valores: Record<string, unknown>) => {
          updates.push({ valores });
          if (linha) Object.assign(linha, valores);
          return { eq: () => ({ eq: async () => ({ error: null }) }) };
        },
      };
      return api;
    },
  } as unknown as Awaited<ReturnType<typeof createClient>>);
  return { updates };
}

function ctx() {
  return { params: Promise.resolve({ id: INVITE }) };
}
function req() {
  return new NextRequest(`http://localhost/api/v1/team/invites/${INVITE}/resend`, { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/team/invites/[id]/resend", () => {
  it("exige admin", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden", "sem permissão", 403, {}),
    } as never);
    const { POST } = await import("./[id]/resend/route");

    const res = await POST(req(), ctx());
    expect(res.status).toBe(403);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("admin");
  });

  it("recusa reenviar convite JÁ ACEITO", async () => {
    authOk();
    makeDb({ id: INVITE, email: "x@x.com", role: "agent", interface_settings: {}, status: "accepted", invited_by: null, resent_count: 0 });
    const { POST } = await import("./[id]/resend/route");

    const res = await POST(req(), ctx());
    expect(res.status).toBe(422);
  });

  it("recusa reenviar convite REVOGADO", async () => {
    authOk();
    makeDb({ id: INVITE, email: "x@x.com", role: "agent", interface_settings: {}, status: "revoked", invited_by: null, resent_count: 0 });
    const { POST } = await import("./[id]/resend/route");

    const res = await POST(req(), ctx());
    expect(res.status).toBe(422);
  });

  it("reenvia convite PENDING (mesmo vencido) — avança o prazo e audita", async () => {
    authOk();
    const { updates } = makeDb({
      id: INVITE,
      email: "x@x.com",
      role: "agent",
      interface_settings: {},
      status: "pending",
      invited_by: null,
      resent_count: 2,
    });
    const { POST } = await import("./[id]/resend/route");

    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect(updates[0]?.valores.resent_count).toBe(3);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "member.invite_resent", resourceId: INVITE }),
    );
  });

  it("404 quando o convite não existe nesta organização", async () => {
    authOk();
    makeDb(null);
    const { POST } = await import("./[id]/resend/route");

    const res = await POST(req(), ctx());
    expect(res.status).toBe(404);
  });
});

describe("POST /api/v1/team/invites/[id]/revoke", () => {
  it("exige admin", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden", "sem permissão", 403, {}),
    } as never);
    const { POST } = await import("./[id]/revoke/route");

    const res = await POST(new NextRequest("http://x", { method: "POST" }), ctx());
    expect(res.status).toBe(403);
  });

  it("revoga um convite pending e audita member.invite_revoked", async () => {
    authOk();
    const { updates } = makeDb({ id: INVITE, email: "x@x.com", status: "pending" });
    const { POST } = await import("./[id]/revoke/route");

    const res = await POST(new NextRequest("http://x", { method: "POST" }), ctx());
    expect(res.status).toBe(200);
    expect(updates[0]?.valores.status).toBe("revoked");
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "member.invite_revoked", resourceId: INVITE }),
    );
  });

  it("revogar DUAS VEZES não é erro — idempotente", async () => {
    authOk();
    const { updates } = makeDb({ id: INVITE, email: "x@x.com", status: "revoked" });
    const { POST } = await import("./[id]/revoke/route");

    const res = await POST(new NextRequest("http://x", { method: "POST" }), ctx());
    expect(res.status).toBe(200);
    // Já estava revogado — não gera um segundo UPDATE nem uma segunda auditoria.
    expect(updates).toEqual([]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});
