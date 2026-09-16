/**
 * `sendTemplateForSession` resolve a credencial POR SESSÃO (banco), com o
 * `.env` como fallback — o MESMO caminho que o envio de texto comum já usa
 * (`resolveMetaCreds`, consumido por `meta-cloud.ts`).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * Antes, esta função lia só `process.env.META_PHONE_NUMBER_ID` e
 * `META_SYSTEM_USER_TOKEN` — igual pra qualquer organização. Numa instalação
 * com duas organizações conectadas na Meta (cada uma com sua própria linha em
 * `channel_sessions`, cifrada), o MODELO de uma delas saía pela conta que
 * estivesse no `.env`, que é a de UMA organização só (ou de nenhuma). O envio
 * de texto comum já não tinha este problema — só o de template.
 *
 * `channel-adapter-meta.test.ts` documenta o mesmo padrão de dublê para o
 * adapter; aqui é a mesma prova, para a função que o `_handler.ts` chama
 * quando o provider não tem `.sendTemplate` no adapter (hoje: só meta_cloud).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessaoNoBanco: { temToken: boolean } = { temToken: false };

function cadeiaChannelSessions(): Record<string, unknown> {
  const alvo: Record<string, unknown> = {
    maybeSingle: async () => ({
      data: sessaoNoBanco.temToken
        ? { meta_phone_number_id: "sessao-pn", meta_token_encrypted: "\\xdeadbeef" }
        : null,
      error: null,
    }),
  };
  alvo.select = () => alvo;
  alvo.eq = () => alvo;
  alvo.is = () => alvo;
  return alvo;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => cadeiaChannelSessions(),
    rpc: async () => ({ data: sessaoNoBanco.temToken ? "token-da-sessao" : null, error: null }),
  }),
}));

const sendTemplateMock = vi.fn(async () => ({ sent: true, externalId: "wamid.OK" }));
vi.mock("./send-template", () => ({ sendTemplate: (...args: unknown[]) => sendTemplateMock(...args) }));

/** `db` — o client passado direto pelo chamador, só para `meta_templates`. */
function fakeDb(linha: Record<string, unknown> | null = null) {
  const alvo: Record<string, unknown> = { maybeSingle: async () => ({ data: linha, error: null }) };
  alvo.select = () => alvo;
  alvo.eq = () => alvo;
  return { from: () => alvo } as never;
}

const input = {
  organizationId: "org-1",
  phoneNumberId: "sessao-pn",
  to: "5531999998888",
  name: "boas_vindas",
  language: "pt_BR",
  values: {},
};

beforeEach(() => {
  sendTemplateMock.mockClear();
  sessaoNoBanco.temToken = false;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sendTemplateForSession — credencial por sessão, .env só como fallback", () => {
  it("⭐ com credencial gravada na sessão, usa o TOKEN e o phoneNumberId da sessão — não o do .env", async () => {
    sessaoNoBanco.temToken = true;
    vi.stubEnv("META_PHONE_NUMBER_ID", "pn-do-env");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "token-do-env");

    const { sendTemplateForSession } = await import("./send-template-for-session");
    await sendTemplateForSession(fakeDb(), input);

    expect(sendTemplateMock).toHaveBeenCalledTimes(1);
    const chamada = sendTemplateMock.mock.calls[0]![0] as { phoneNumberId: string; token: string };
    expect(chamada.phoneNumberId).toBe("sessao-pn");
    expect(chamada.token).toBe("token-da-sessao");
  });

  it("sem credencial na sessão, cai para o .env (instalação de número único)", async () => {
    sessaoNoBanco.temToken = false;
    vi.stubEnv("META_PHONE_NUMBER_ID", "pn-do-env");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "token-do-env");

    const { sendTemplateForSession } = await import("./send-template-for-session");
    await sendTemplateForSession(fakeDb(), input);

    const chamada = sendTemplateMock.mock.calls[0]![0] as { phoneNumberId: string; token: string };
    expect(chamada.phoneNumberId).toBe("pn-do-env");
    expect(chamada.token).toBe("token-do-env");
  });

  it("sem sessão E sem .env, lança em vez de mandar credencial vazia pra Graph API", async () => {
    sessaoNoBanco.temToken = false;
    vi.stubEnv("META_PHONE_NUMBER_ID", "");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "");

    const { sendTemplateForSession } = await import("./send-template-for-session");
    await expect(sendTemplateForSession(fakeDb(), input)).rejects.toThrow(/meta_not_configured/);
    expect(sendTemplateMock).not.toHaveBeenCalled();
  });
});
