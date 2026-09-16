/**
 * `updateMetaApp` — cadastra o App Secret da Meta pela tela de admin.
 *
 * O que se mede: o secret NUNCA sai em claro (nem no upsert, nem na resposta,
 * nem no metadata do audit), a cifra recusada barra a escrita, e o `upsert`
 * não apaga o `webhook_verify_token` que já estava salvo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const PLAINTEXT = "meu-app-secret-super-secreto";
const CIFRADO = "\\xdeadbeef";

const encryptMock = vi.fn(async () => CIFRADO);
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: (...args: unknown[]) => encryptMock(...args),
}));

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

import { updateMetaApp } from "./updateMetaApp";

beforeEach(() => {
  vi.clearAllMocks();
  upsertedRows.length = 0;
  encryptMock.mockResolvedValue(CIFRADO);
});

describe("updateMetaApp", () => {
  it("⭐ cifra o secret antes de gravar — o texto puro nunca chega no upsert", async () => {
    const r = await updateMetaApp({ app_secret: PLAINTEXT });

    expect(r.ok).toBe(true);
    expect(encryptMock).toHaveBeenCalledWith(expect.anything(), PLAINTEXT);
    expect(upsertedRows).toHaveLength(1);
    expect(upsertedRows[0]?.app_secret_encrypted).toBe(CIFRADO);
    expect(
      JSON.stringify(upsertedRows[0]),
      "o texto puro do secret vazou pro que foi gravado no banco",
    ).not.toContain(PLAINTEXT);
  });

  it("⭐ o secret NUNCA aparece na resposta da action", async () => {
    const r = await updateMetaApp({ app_secret: PLAINTEXT });
    expect(JSON.stringify(r)).not.toContain(PLAINTEXT);
    expect(JSON.stringify(r)).not.toContain(CIFRADO);
  });

  it("⭐ o secret NUNCA aparece no metadata do audit", async () => {
    await updateMetaApp({ app_secret: PLAINTEXT });
    expect(auditMock).toHaveBeenCalledTimes(1);
    const chamada = auditMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(JSON.stringify(chamada)).not.toContain(PLAINTEXT);
    expect(JSON.stringify(chamada)).not.toContain(CIFRADO);
    expect(chamada.action).toBe("platform_meta_app.secret_updated");
  });

  it("⭐ cifra indisponível (GUC ausente) RECUSA — nunca grava em claro", async () => {
    encryptMock.mockResolvedValue(null);

    const r = await updateMetaApp({ app_secret: PLAINTEXT });

    expect(r.ok).toBe(false);
    expect(
      upsertedRows,
      "a recusa da cifra não impediu a escrita — o secret pode ter ido em claro",
    ).toHaveLength(0);
    if (!r.ok) expect(r.error).not.toContain(PLAINTEXT);
  });

  it("upsert não apaga webhook_verify_token — só grava as colunas que mudaram", async () => {
    await updateMetaApp({ app_secret: PLAINTEXT });
    // A chamada não inclui `webhook_verify_token` nenhum — é assim que o
    // upsert do PostgREST evita zerar uma coluna que a chamada não tocou.
    expect(upsertedRows[0]).not.toHaveProperty("webhook_verify_token");
  });

  it("entrada vazia é recusada pelo schema antes de chegar na cifra", async () => {
    const r = await updateMetaApp({ app_secret: "" });
    expect(r.ok).toBe(false);
    expect(encryptMock).not.toHaveBeenCalled();
  });
});
