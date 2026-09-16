/**
 * GET /api/v1/conversation-tags — vocabulário do filtro de etiqueta do Inbox.
 *
 * Achado no changelog upstream: a rota só listava o que estava CADASTRADO em
 * `organizations.settings.canonical_conversation_tags` — uma etiqueta
 * aplicada direto numa conversa (edição avulsa, import, automação) sem nunca
 * ter passado pela tela de cadastro não aparecia como opção de filtro, mesmo
 * já estando em uso. Agora a rota faz UNION com `fn_tags_de_conversa_em_uso`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";

function req() {
  return new NextRequest("http://localhost/api/v1/conversation-tags");
}

function stubSupabase(opts: { cadastradas: string[]; emUso: string[] }) {
  return {
    from: (table: string) => {
      if (table !== "organizations") throw new Error(`tabela inesperada: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { settings: { canonical_conversation_tags: opts.cadastradas } },
              error: null,
            }),
          }),
        }),
      };
    },
    rpc: async (fn: string) => {
      if (fn !== "fn_tags_de_conversa_em_uso") throw new Error(`rpc inesperada: ${fn}`);
      return { data: opts.emUso, error: null };
    },
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
    organizations: [{ organization_id: ORG, organization_name: "Org", role: "viewer" }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG, name: "Org", role: "viewer" },
  });
});

describe("conversation-tags — UNION cadastradas + em uso", () => {
  it("inclui tag aplicada numa conversa mesmo sem estar cadastrada", async () => {
    vi.mocked(createClient).mockResolvedValue(
      stubSupabase({ cadastradas: ["vip"], emUso: ["vip", "urgente"] }) as never,
    );

    const { GET } = await import("./route");
    const res = await GET(req());
    const body = (await res.json()) as { data: string[] };

    expect(body.data).toContain("vip");
    expect(body.data).toContain("urgente");
  });

  it("não duplica quando a mesma tag está nas duas listas", async () => {
    vi.mocked(createClient).mockResolvedValue(
      stubSupabase({ cadastradas: ["vip"], emUso: ["vip"] }) as never,
    );

    const { GET } = await import("./route");
    const res = await GET(req());
    const body = (await res.json()) as { data: string[] };

    expect(body.data.filter((t) => t === "vip")).toHaveLength(1);
  });

  it("cadastradas + em uso somando mais de 50 não apaga a lista (dedupe antes do teto)", async () => {
    const cadastradas = Array.from({ length: 45 }, (_, i) => `tag-${i}`);
    // As mesmas 45 reaparecem "em uso" (cenário real: tag cadastrada E usada)
    // mais 10 novas — cru vira 55, mas deduplicado são só 55 distintas... para
    // testar o teto de verdade, repete as 45 cadastradas inteiras como "em uso".
    const emUso = [...cadastradas, ...Array.from({ length: 4 }, (_, i) => `nova-${i}`)];
    vi.mocked(createClient).mockResolvedValue(stubSupabase({ cadastradas, emUso }) as never);

    const { GET } = await import("./route");
    const res = await GET(req());
    const body = (await res.json()) as { data: string[] };

    // Sem o dedupe-antes-do-teto, 45+49=94 brutos estourariam max(50) e a
    // resposta viraria [] silenciosamente (`.catch([])`).
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data).toContain("tag-0");
    expect(body.data).toContain("nova-0");
  });
});
