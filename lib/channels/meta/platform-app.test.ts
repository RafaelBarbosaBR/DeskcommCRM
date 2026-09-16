/**
 * O App da Meta EM VIGOR (Onda 4.3) — tabela primeiro, `.env` como fallback
 * CAMPO A CAMPO.
 *
 * ⚠️ Os dois campos são lidos por FUNÇÕES SEPARADAS
 * (`platformMetaAppSecret`/`platformMetaAppVerifyToken`), de propósito —
 * ver o cabeçalho de `platform-app.ts`. Um getter combinado que exigisse os
 * dois para devolver QUALQUER um deles quebraria a configuração parcial
 * (token gerado pela tela, secret ainda no `.env`, ou vice-versa).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const decryptMock = vi.fn();
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: (...args: unknown[]) => decryptMock(...args),
}));

import {
  platformMetaAppSecret,
  platformMetaAppStatus,
  platformMetaAppVerifyToken,
} from "@/lib/channels/meta/platform-app";

interface Linha {
  app_secret_encrypted: string | null;
  webhook_verify_token: string | null;
  updated_at: string | null;
}

let linha: Linha | null;

function admin() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: linha, error: null }) }),
      }),
    }),
  } as never;
}

beforeEach(() => {
  linha = null;
  decryptMock.mockReset();
});

afterEach(() => vi.unstubAllEnvs());

describe("platformMetaAppSecret — tabela primeiro, .env como fallback", () => {
  it("⭐ tabela com secret que decifra: usa o valor decifrado, não o .env", async () => {
    linha = { app_secret_encrypted: "\\xdeadbeef", webhook_verify_token: null, updated_at: null };
    decryptMock.mockResolvedValue("secret-da-tabela");
    vi.stubEnv("META_APP_SECRET", "secret-do-env");

    expect(await platformMetaAppSecret(admin())).toBe("secret-da-tabela");
  });

  it("⭐ tabela vazia: cai pro .env", async () => {
    linha = null;
    vi.stubEnv("META_APP_SECRET", "secret-do-env");

    expect(await platformMetaAppSecret(admin())).toBe("secret-do-env");
  });

  it("tabela tem secret mas a cifra falha (GUC ausente): cai pro .env, não trava", async () => {
    linha = { app_secret_encrypted: "\\xdeadbeef", webhook_verify_token: null, updated_at: null };
    decryptMock.mockResolvedValue(null);
    vi.stubEnv("META_APP_SECRET", "secret-do-env");

    expect(await platformMetaAppSecret(admin())).toBe("secret-do-env");
  });

  it("nem tabela nem .env: null — o chamador trata como 'não pode verificar', não como erro", async () => {
    linha = null;
    expect(await platformMetaAppSecret(admin())).toBeNull();
  });
});

describe("platformMetaAppVerifyToken — mesma régua, independente do secret", () => {
  it("⭐ token na tabela: usa o valor da tabela, não o .env", async () => {
    linha = { app_secret_encrypted: null, webhook_verify_token: "token-da-tabela", updated_at: null };
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "token-do-env");

    expect(await platformMetaAppVerifyToken(admin())).toBe("token-da-tabela");
  });

  it("sem token na tabela: cai pro .env", async () => {
    linha = { app_secret_encrypted: null, webhook_verify_token: null, updated_at: null };
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "token-do-env");

    expect(await platformMetaAppVerifyToken(admin())).toBe("token-do-env");
  });

  it("⭐ configuração PARCIAL: token na tabela funciona mesmo sem secret nenhum configurado", async () => {
    // A prova da independência entre os dois campos — o defeito que um
    // getter combinado ("os dois ou nenhum") introduziria.
    linha = { app_secret_encrypted: null, webhook_verify_token: "token-da-tabela", updated_at: null };
    expect(await platformMetaAppVerifyToken(admin())).toBe("token-da-tabela");
    expect(await platformMetaAppSecret(admin())).toBeNull();
  });
});

describe("platformMetaAppStatus — NUNCA o valor, só configured/source", () => {
  it("⭐ o secret decifrado nunca aparece no status, nem serializado", async () => {
    linha = {
      app_secret_encrypted: "\\xdeadbeef",
      webhook_verify_token: "token-secreto-da-tabela",
      updated_at: "2026-09-15T00:00:00.000Z",
    };
    decryptMock.mockResolvedValue("segredo-nao-pode-vazar");

    const status = await platformMetaAppStatus(admin());
    const serializado = JSON.stringify(status);

    expect(serializado).not.toContain("segredo-nao-pode-vazar");
    expect(serializado).not.toContain("token-secreto-da-tabela");
    expect(status).toEqual({
      appSecret: { configured: true, source: "table" },
      webhookVerifyToken: { configured: true, source: "table" },
      updatedAt: "2026-09-15T00:00:00.000Z",
    });
  });

  it("fonte 'env' quando só o .env tem o campo", async () => {
    linha = null;
    vi.stubEnv("META_APP_SECRET", "x");
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "y");

    const status = await platformMetaAppStatus(admin());
    expect(status.appSecret).toEqual({ configured: true, source: "env" });
    expect(status.webhookVerifyToken).toEqual({ configured: true, source: "env" });
  });

  it("fonte 'none' quando nem tabela nem .env têm o campo", async () => {
    linha = null;
    const status = await platformMetaAppStatus(admin());
    expect(status.appSecret).toEqual({ configured: false, source: "none" });
    expect(status.webhookVerifyToken).toEqual({ configured: false, source: "none" });
  });
});
