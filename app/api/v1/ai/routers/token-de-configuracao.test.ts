import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import type { Role } from "@/lib/auth/types";
import type * as McpAuthModule from "@/lib/mcp/auth";

/**
 * Roteador de IA é configuração de IA: pelo token vale a regra de #2194 —
 * escopo próprio `config:*` com token de administrador. O `resolveAuthDual` é
 * o REAL; só a busca do token no banco é dublada.
 *
 * O caso que importa é o token que JÁ existia antes desta porta abrir:
 * "AGIR no CRM" + "Tratar como administrador", sem a permissão de configurar.
 * Ele não pode ganhar o poder de apagar roteador nem trocar quem atende.
 */

const deps = vi.hoisted(() => ({ validateBearerToken: vi.fn() }));

vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof McpAuthModule>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: deps.validateBearerToken };
});
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

import { GET as getRouters, POST as postRouter } from "./route";
import { DELETE as deleteRouter, GET as getRouter, PATCH as patchRouter } from "./[id]/route";
import { PUT as putMembers } from "./[id]/members/route";
import { POST as testRouter } from "./[id]/test/route";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const ROUTER_ID = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ id: ROUTER_ID }) };

/** O papel do token sai do escopo `role:*`; aqui ele vai explícito ao lado. */
function comToken(scopes: string[], role: Role) {
  deps.validateBearerToken.mockResolvedValue({
    organizationId: ORG_ID,
    role,
    actor: { type: "api_token", id: "tok-config", role },
    apiTokenId: "tok-config",
    scopes,
  });
}

function bearer(path: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost/api/v1/ai/routers${path}`, {
    method,
    headers: { authorization: "Bearer dsk_config", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Só o que o DELETE consulta: achar o router da org e apagá-lo. */
function bancoDoDelete() {
  const filtro = {
    eq: () => filtro,
    maybeSingle: async () => ({ data: { id: ROUTER_ID }, error: null }),
    then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
  };
  return { from: () => ({ select: () => filtro, delete: () => filtro }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

const PORTAS = [
  { nome: "GET /routers", leitura: true, chamar: () => getRouters(bearer("", "GET")) },
  { nome: "GET /routers/:id", leitura: true, chamar: () => getRouter(bearer(`/${ROUTER_ID}`, "GET"), ctx) },
  {
    nome: "POST /routers",
    leitura: false,
    chamar: () => postRouter(bearer("", "POST", { name: "x", channel_session_id: ROUTER_ID })),
  },
  {
    nome: "PATCH /routers/:id",
    leitura: false,
    chamar: () => patchRouter(bearer(`/${ROUTER_ID}`, "PATCH", { name: "x" }), ctx),
  },
  { nome: "DELETE /routers/:id", leitura: false, chamar: () => deleteRouter(bearer(`/${ROUTER_ID}`, "DELETE"), ctx) },
  {
    nome: "PUT /routers/:id/members",
    leitura: false,
    chamar: () => putMembers(bearer(`/${ROUTER_ID}/members`, "PUT", { members: [] }), ctx),
  },
  {
    nome: "POST /routers/:id/test",
    leitura: false,
    chamar: () => testRouter(bearer(`/${ROUTER_ID}/test`, "POST", { message: "oi" }), ctx),
  },
];

const TOKENS_QUE_JA_EXISTEM = [
  ["mcp:write", "role:admin"],
  ["mcp:read", "mcp:write", "role:admin"],
];

describe("roteador por token exige a permissão de configurar a IA (#2194)", () => {
  it.each(PORTAS.flatMap((p) => TOKENS_QUE_JA_EXISTEM.map((scopes) => ({ ...p, scopes }))))(
    "$nome: token já emitido $scopes recebe 403",
    async ({ chamar, scopes }) => {
      comToken(scopes, "admin");

      const res = await chamar();

      expect(res.status).toBe(403);
      expect(createAdminClient).not.toHaveBeenCalled();
    },
  );

  it.each(PORTAS)("$nome: permissão de configurar sem role:admin recebe 403", async ({ chamar, leitura }) => {
    comToken([leitura ? "config:read" : "config:write", "role:manager"], "manager");

    const res = await chamar();

    expect(res.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it.each(PORTAS.filter((p) => !p.leitura))("$nome: config:read + role:admin não escreve (403)", async ({ chamar }) => {
    comToken(["config:read", "role:admin"], "admin");

    const res = await chamar();

    expect(res.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("token NOVO com config:write + role:admin apaga o roteador (200)", async () => {
    comToken(["config:write", "role:admin"], "admin");
    vi.mocked(createAdminClient).mockReturnValue(bancoDoDelete() as never);

    const res = await deleteRouter(bearer(`/${ROUTER_ID}`, "DELETE"), ctx);

    expect(res.status).toBe(200);
  });
});
