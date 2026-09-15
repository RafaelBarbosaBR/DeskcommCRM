/**
 * A CAUSA REAL DA FALHA CHEGA ATÉ A RESPOSTA — E ATÉ O LOG.
 *
 * `generateReplyDraft` nomeia as próprias causas com `throw new Error(...)`
 * (`reply_no_agent`, `reply_context_unavailable`, ver `reply-drafts.ts`). O
 * `catch` desta rota descartava `err` inteiro: nenhuma das duas chegava à
 * tela, a resposta era SEMPRE a mesma frase genérica, e nada era logado — o
 * `requestId` mostrado ao lado do erro não levava a nada gravado, e quem
 * investigava um "não consegui gerar a sugestão" não tinha por onde começar.
 *
 * O que se prende aqui: as duas causas CONHECIDAS viram mensagem específica
 * (sem precisar de log — já são esperadas); qualquer OUTRA causa continua
 * com a mensagem genérica de antes (comportamento visível preservado), mas
 * agora loga o motivo real com o `requestId`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => ({})) }));
vi.mock("@/lib/agent-engine/agent/request-deps", () => ({ requestTurnDeps: vi.fn(() => ({})) }));
vi.mock("@/lib/agent-engine/agent/reply-drafts", () => ({ generateReplyDraft: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const errorMock = vi.fn();
vi.mock("@/lib/logger", () => ({ logger: { error: (...args: unknown[]) => errorMock(...args) } }));

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { generateReplyDraft } from "@/lib/agent-engine/agent/reply-drafts";
import { createClient } from "@/lib/supabase/server";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const CONV = "33333333-3333-4333-8333-333333333333";

function authOk(): void {
  const user: AuthUser = {
    id: USER,
    email: "agente@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role: "agent" }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG, name: "Org", role: "agent" },
  });
}

function dbOk(): void {
  vi.mocked(createClient).mockResolvedValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { id: CONV, contact_id: "contato-1", channel_session_id: "canal-1" },
            }),
          }),
        }),
      }),
    }),
  } as unknown as Awaited<ReturnType<typeof createClient>>);
}

function req(): NextRequest {
  return new NextRequest(`http://localhost/api/v1/conversations/${CONV}/draft-reply`, {
    method: "POST",
  });
}
function ctx() {
  return { params: Promise.resolve({ id: CONV }) };
}

async function corpo(res: Response) {
  return (await res.json()) as { error: { code: string; message: string } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/conversations/[id]/draft-reply — a causa real da falha", () => {
  it("reply_no_agent: mensagem específica, sem log (causa já conhecida)", async () => {
    authOk();
    dbOk();
    vi.mocked(generateReplyDraft).mockRejectedValue(new Error("reply_no_agent"));
    const { POST } = await import("./route");

    const res = await POST(req(), ctx());

    expect(res.status).toBe(422);
    const body = await corpo(res);
    expect(body.error.message).toMatch(/agente de ia/i);
    expect(errorMock, "causa conhecida não precisa de log").not.toHaveBeenCalled();
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("reply_context_unavailable: outra mensagem específica, também sem log", async () => {
    authOk();
    dbOk();
    vi.mocked(generateReplyDraft).mockRejectedValue(new Error("reply_context_unavailable"));
    const { POST } = await import("./route");

    const res = await POST(req(), ctx());

    expect(res.status).toBe(422);
    const body = await corpo(res);
    expect(body.error.message).toMatch(/contexto/i);
    expect(errorMock).not.toHaveBeenCalled();
  });

  it("causa desconhecida: mantém a mensagem genérica de antes, mas AGORA loga o motivo real", async () => {
    authOk();
    dbOk();
    vi.mocked(generateReplyDraft).mockRejectedValue(new Error("conexão com o provedor caiu"));
    const { POST } = await import("./route");

    const res = await POST(req(), ctx());

    expect(res.status).toBe(422);
    const body = await corpo(res);
    // A frase que já existia antes do conserto — comportamento visível
    // preservado para quem cai numa causa que este catch ainda não nomeia.
    expect(body.error.message).toMatch(
      /não foi possível gerar a sugestão\. confira a publicação e a configuração do agente\./i,
    );
    expect(errorMock, "causa desconhecida ficou muda — o requestId não aponta pra nada").toHaveBeenCalledWith(
      expect.stringContaining("draft-reply"),
      expect.objectContaining({
        error: "conexão com o provedor caiu",
        conversationId: CONV,
        organizationId: ORG,
      }),
    );
  });

  it("erro que não é Error (ex.: string lançada) também vira mensagem genérica, sem quebrar o log", async () => {
    authOk();
    dbOk();
    vi.mocked(generateReplyDraft).mockRejectedValue("algo não-Error");
    const { POST } = await import("./route");

    const res = await POST(req(), ctx());

    expect(res.status).toBe(422);
    expect(errorMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: "algo não-Error" }),
    );
  });
});
