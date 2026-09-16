/**
 * POST/GET/DELETE /api/v1/agenda/excecoes — fechar um dia (feriado, férias).
 *
 * `calendar_availability_exceptions` e `janelasDoDia` já existiam (migration
 * 0177); esta é a primeira rota que escreve nessa tabela. O teste prova o
 * contrato que `janelasDoDia` já espera: `is_unavailable`/`start_minute`/
 * `end_minute` chegam no formato certo, e a rota nunca escreve pra outra
 * pessoa (sempre `user_id = auth.uid()`, nunca do corpo).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
// Isola o handler; a autoridade de suporte é exercitada na suíte própria dela.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";

function req(body?: unknown) {
  return new NextRequest("http://localhost/api/v1/agenda/excecoes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function stubAdmin(opts: {
  insertRow?: Record<string, unknown>;
  insertError?: { code?: string; message: string };
  inserted?: Record<string, unknown>[];
}) {
  const chamadas: Array<{ metodo: string; args: unknown[] }> = [];
  return {
    client: {
      from: (table: string) => {
        if (table !== "calendar_availability_exceptions") throw new Error(`tabela inesperada: ${table}`);
        return {
          insert: (row: Record<string, unknown>) => {
            chamadas.push({ metodo: "insert", args: [row] });
            return {
              select: () => ({
                single: async () =>
                  opts.insertError
                    ? { data: null, error: opts.insertError }
                    : { data: { id: "exc-1", ...row }, error: null },
              }),
            };
          },
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: async () => ({ data: opts.inserted ?? [], error: null }),
              }),
            }),
          }),
          delete: () => {
            let idFiltrado: unknown;
            const chain = {
              eq: (col: string, val: unknown) => {
                chamadas.push({ metodo: "delete.eq", args: [col, val] });
                if (col === "id") idFiltrado = val;
                return chain;
              },
              select: () => ({
                maybeSingle: async () => ({ data: { id: idFiltrado }, error: null }),
              }),
            };
            return chain;
          },
        };
      },
    },
    chamadas,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const user: AuthUser = {
    id: USER,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role: "agent" }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) =>
    ROLE_RANK["agent"] >= ROLE_RANK[min]
      ? { ok: true, user, org: { orgId: ORG, name: "Org", role: "agent" } }
      : ({ ok: false, response: null } as never),
  );
});

describe("POST /api/v1/agenda/excecoes", () => {
  it("cria fechando o dia inteiro por padrão — is_unavailable true, 0..1440", async () => {
    const { client, chamadas } = stubAdmin({});
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const { POST } = await import("./route");
    const res = await POST(req({ exception_date: "2026-12-25", reason: "Natal" }));
    const body = (await res.json()) as { data?: { id: string } };

    expect(res.status).toBe(201);
    expect(body.data?.id).toBe("exc-1");
    const insertCall = chamadas.find((c) => c.metodo === "insert");
    expect(insertCall?.args[0]).toMatchObject({
      organization_id: ORG,
      user_id: USER,
      exception_date: "2026-12-25",
      is_unavailable: true,
      start_minute: 0,
      end_minute: 1440,
      reason: "Natal",
    });
  });

  it("nunca escreve user_id vindo do corpo — sempre o da sessão", async () => {
    const { client, chamadas } = stubAdmin({});
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const { POST } = await import("./route");
    await POST(req({ exception_date: "2026-12-25", user_id: "99999999-9999-4999-8999-999999999999" }));

    const insertCall = chamadas.find((c) => c.metodo === "insert");
    expect((insertCall?.args[0] as { user_id: string }).user_id).toBe(USER);
  });

  it("rejeita fim <= início (422, não vira erro de constraint)", async () => {
    const { client } = stubAdmin({});
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const { POST } = await import("./route");
    const res = await POST(
      req({ exception_date: "2026-12-25", start_minute: 600, end_minute: 600 }),
    );
    expect(res.status).toBe(422);
  });

  it("data em formato errado é recusada", async () => {
    const { client } = stubAdmin({});
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const { POST } = await import("./route");
    const res = await POST(req({ exception_date: "25/12/2026" }));
    expect(res.status).toBe(422);
  });

  it("dia duplicado (23505) vira 409, não 500", async () => {
    const { client } = stubAdmin({ insertError: { code: "23505", message: "duplicate" } });
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const { POST } = await import("./route");
    const res = await POST(req({ exception_date: "2026-12-25" }));
    expect(res.status).toBe(409);
  });
});

describe("DELETE /api/v1/agenda/excecoes", () => {
  it("só remove filtrando pelo user_id da sessão", async () => {
    const { client, chamadas } = stubAdmin({});
    vi.mocked(createAdminClient).mockReturnValue(client as never);

    const { DELETE } = await import("./route");
    const res = await DELETE(req({ id: "33333333-3333-4333-8333-333333333333" }));

    expect(res.status).toBe(200);
    const filtroPorUser = chamadas.find(
      (c) => c.metodo === "delete.eq" && c.args[0] === "user_id",
    );
    expect(filtroPorUser?.args[1]).toBe(USER);
  });
});
