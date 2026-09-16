/**
 * `regenerateMetaVerifyToken` — gera/regera o `webhook_verify_token`.
 *
 * O que se mede: cada chamada devolve um valor NOVO (não repete o anterior),
 * o valor gravado é o MESMO que volta na resposta (senão a tela mostraria um
 * token que não é o que ficou salvo), e o upsert não apaga o App Secret.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const auditMock = vi.fn(async () => undefined);
vi.mock("@/lib/audit", () => ({ audit: (...args: unknown[]) => auditMock(...args) }));

vi.mock("next/headers", () => ({
  headers: async () => new Map<string, string>([["x-request-id", "req-1"]]),
}));

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
vi.mock("@/lib/auth/requirePlatformAdmin", () => ({
  requirePlatformAdmin: vi.fn(async () => ({ user: { id: ADMIN_ID } })),
}));

const upsertedRows: Array<Record<string, unknown>> = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      upsert: (linha: Record<string, unknown>) => {
        upsertedRows.push(linha);
        return Promise.resolve({ error: null });
      },
    }),
  }),
}));

import { regenerateMetaVerifyToken } from "./regenerateMetaVerifyToken";

beforeEach(() => {
  vi.clearAllMocks();
  upsertedRows.length = 0;
});

describe("regenerateMetaVerifyToken", () => {
  it("⭐ devolve o MESMO valor que grava — a tela não pode mostrar um token diferente do salvo", async () => {
    const r = await regenerateMetaVerifyToken();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(upsertedRows).toHaveLength(1);
    expect(upsertedRows[0]?.webhook_verify_token).toBe(r.webhook_verify_token);
  });

  it("⭐ duas chamadas seguidas geram DOIS valores diferentes", async () => {
    const r1 = await regenerateMetaVerifyToken();
    const r2 = await regenerateMetaVerifyToken();
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.webhook_verify_token).not.toBe(r2.webhook_verify_token);
  });

  it("o valor tem entropia real (48 hex chars — 24 bytes)", async () => {
    const r = await regenerateMetaVerifyToken();
    if (!r.ok) throw new Error("deveria ter gerado");
    expect(r.webhook_verify_token).toMatch(/^[0-9a-f]{48}$/);
  });

  it("upsert não apaga app_secret_encrypted — só grava a coluna que mudou", async () => {
    await regenerateMetaVerifyToken();
    expect(upsertedRows[0]).not.toHaveProperty("app_secret_encrypted");
  });

  it("registra no audit sem o valor do token em claro no metadata", async () => {
    const r = await regenerateMetaVerifyToken();
    if (!r.ok) throw new Error("deveria ter gerado");
    expect(auditMock).toHaveBeenCalledTimes(1);
    const chamada = auditMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(chamada.action).toBe("platform_meta_app.verify_token_regenerated");
    expect(JSON.stringify(chamada.metadata ?? {})).not.toContain(r.webhook_verify_token);
  });
});
