/**
 * O MODELO PADRÃO DA ORGANIZAÇÃO — a escrita que faltava.
 *
 * `organizations.settings.llm.{provider,default_model}` já era LIDO por
 * `decidirBinding()` como último degrau (24 dos 25 pontos numa instalação
 * nova caem nele), mas nascia só do seed e nunca tinha porta de escrita. O
 * que se prende aqui:
 *
 *  1. Só `admin` grava — mesmo corte de `definirExigenciaDeMfa`.
 *  2. A validação usa `agent_turn` como o ponto mais exigente que pode herdar
 *     este valor (`tools` + `imagem`) — um modelo sem ferramentas não pode
 *     virar o padrão, porque isso quebraria "Responder o cliente" em
 *     silêncio: o agente conversa e não cria lead nenhum.
 *  3. `settings` é jsonb COMPARTILHADO (marca, política de MFA moram no
 *     mesmo objeto) — a escrita faz read-modify-write, nunca substitui o
 *     objeto inteiro.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(), resolveActiveOrg: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: vi.fn(() => false) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";

/** Estado do banco falso: settings atuais da organização + catálogo de modelos. */
interface Estado {
  settingsAtuais: Record<string, unknown>;
  modelosConhecidos: Array<{ provider: string; model_id: string; supports_tools: boolean }>;
}

function makeAdmin(estado: Estado) {
  const updates: Array<{ tabela: string; valores: Record<string, unknown> }> = [];

  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => {
      const filtros: Record<string, unknown> = {};
      const api = {
        select: () => api,
        eq: (col: string, val: unknown) => {
          filtros[col] = val;
          return api;
        },
        is: () => api,
        update: (valores: Record<string, unknown>) => {
          updates.push({ tabela, valores });
          return { eq: async () => ({ error: null }) };
        },
        maybeSingle: async () => {
          if (tabela === "organizations") {
            return { data: { settings: estado.settingsAtuais }, error: null };
          }
          if (tabela === "ai_models") {
            const achado = estado.modelosConhecidos.find(
              (m) => m.provider === filtros.provider && m.model_id === filtros.model_id,
            );
            return { data: achado ?? null, error: null };
          }
          return { data: null, error: null };
        },
      };
      return api;
    },
  } as unknown as ReturnType<typeof createAdminClient>);

  return { updates };
}

function authOk(role: "admin" | "manager" | "agent" = "admin"): void {
  vi.mocked(loadAuthUser).mockResolvedValue({ id: USER, support: null } as never);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG, role } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("atualizarModeloPadraoDaOrganizacao — quem pode gravar", () => {
  it("recusa quem não é admin, sem escrever nada", async () => {
    authOk("manager");
    const { updates } = makeAdmin({ settingsAtuais: {}, modelosConhecidos: [] });
    const { atualizarModeloPadraoDaOrganizacao } = await import("./updateDefaultAiModel");

    const r = await atualizarModeloPadraoDaOrganizacao("anthropic", "claude-sonnet-4-6");

    expect(r.ok).toBe(false);
    expect(updates).toEqual([]);
  });

  it("recusa sem organização ativa", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue({ id: USER, support: null } as never);
    vi.mocked(resolveActiveOrg).mockResolvedValue(null as never);
    makeAdmin({ settingsAtuais: {}, modelosConhecidos: [] });
    const { atualizarModeloPadraoDaOrganizacao } = await import("./updateDefaultAiModel");

    const r = await atualizarModeloPadraoDaOrganizacao("anthropic", "claude-sonnet-4-6");
    expect(r.ok).toBe(false);
  });
});

describe("atualizarModeloPadraoDaOrganizacao — validação (via agent_turn)", () => {
  it("recusa provedor não suportado, sem consultar o catálogo", async () => {
    authOk();
    const { updates } = makeAdmin({ settingsAtuais: {}, modelosConhecidos: [] });
    const { atualizarModeloPadraoDaOrganizacao } = await import("./updateDefaultAiModel");

    const r = await atualizarModeloPadraoDaOrganizacao("provedor-fantasma", "x");
    expect(r.ok).toBe(false);
    expect(updates).toEqual([]);
  });

  it("modelo CONHECIDO sem ferramentas é recusado — quebraria 'Responder o cliente' em silêncio", async () => {
    authOk();
    const { updates } = makeAdmin({
      settingsAtuais: {},
      modelosConhecidos: [{ provider: "anthropic", model_id: "modelo-fraco", supports_tools: false }],
    });
    const { atualizarModeloPadraoDaOrganizacao } = await import("./updateDefaultAiModel");

    const r = await atualizarModeloPadraoDaOrganizacao("anthropic", "modelo-fraco");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erro).toMatch(/ferramentas/i);
    expect(updates).toEqual([]);
  });

  it("modelo FORA do catálogo passa com aviso — endpoint próprio é caminho legítimo", async () => {
    authOk();
    makeAdmin({ settingsAtuais: {}, modelosConhecidos: [] });
    const { atualizarModeloPadraoDaOrganizacao } = await import("./updateDefaultAiModel");

    const r = await atualizarModeloPadraoDaOrganizacao("anthropic", "modelo-desconhecido");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.avisos.length).toBeGreaterThan(0);
  });
});

describe("atualizarModeloPadraoDaOrganizacao — a escrita preserva o resto de settings", () => {
  it("grava provider/default_model SEM apagar outras chaves do jsonb", async () => {
    authOk();
    const { updates } = makeAdmin({
      settingsAtuais: { security: { mfa_required: true }, marca: { nome: "Orbita" } },
      modelosConhecidos: [{ provider: "anthropic", model_id: "claude-sonnet-4-6", supports_tools: true }],
    });
    const { atualizarModeloPadraoDaOrganizacao } = await import("./updateDefaultAiModel");

    const r = await atualizarModeloPadraoDaOrganizacao("anthropic", "claude-sonnet-4-6");

    expect(r.ok).toBe(true);
    expect(updates).toHaveLength(1);
    const gravado = updates[0]!.valores.settings as Record<string, unknown>;
    expect(gravado.security, "apagou a política de MFA de outro escritor do mesmo jsonb").toEqual({
      mfa_required: true,
    });
    expect(gravado.marca, "apagou a marca — outro escritor do mesmo jsonb").toEqual({ nome: "Orbita" });
    expect(gravado.llm).toEqual({ provider: "anthropic", default_model: "claude-sonnet-4-6" });
  });

  it("audita a troca e revalida o layout", async () => {
    authOk();
    makeAdmin({
      settingsAtuais: {},
      modelosConhecidos: [{ provider: "anthropic", model_id: "claude-sonnet-4-6", supports_tools: true }],
    });
    const { atualizarModeloPadraoDaOrganizacao } = await import("./updateDefaultAiModel");
    const { revalidatePath } = await import("next/cache");

    await atualizarModeloPadraoDaOrganizacao("anthropic", "claude-sonnet-4-6");

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai.purpose_binding_updated", organizationId: ORG }),
    );
    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/app", "layout");
  });
});
