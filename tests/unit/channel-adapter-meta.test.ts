import { afterEach, describe, expect, it, vi } from "vitest";

import { getAdapter } from "@/lib/channels";

/**
 * O adapter resolve a credencial POR SESSÃO (banco) com o env como fallback. Sem
 * mockar o admin client, o `fetch` stubado captura a query do Supabase em vez da
 * chamada à Graph API — foi assim que estes testes vermelharam quando a resolução
 * por sessão entrou, e o vermelho foi correto.
 */
const sessaoNoBanco: { token: string | null } = { token: null };

/**
 * Cadeia ENCADEÁVEL, não de um nível só.
 *
 * A resolução por sessão filtra `organization_id` E o identificador E
 * `archived_at is null` (issue #236 / migration 0165), então um stub em que
 * `eq()` já devolve `maybeSingle` deixa de casar com o código real — e um mock
 * que não casa com o código testa o mock. Aqui qualquer combinação de
 * `.eq()/.is()` volta para o mesmo objeto e o terminal é `maybeSingle`.
 */
function cadeia(): Record<string, unknown> {
  const alvo: Record<string, unknown> = {
    maybeSingle: async () => ({
      data: sessaoNoBanco.token
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
    from: () => cadeia(),
    rpc: async () => ({ data: sessaoNoBanco.token, error: null }),
  }),
}));

const a = () => getAdapter("meta_cloud");

/**
 * A organização atravessa o seam de canal desde a issue #236: `sessionRef` é
 * identificador do PROVIDER e não identifica linha sozinho.
 */
const ORG = "00000000-0000-4000-8000-000000000236";

function configurar() {
  vi.stubEnv("META_PHONE_NUMBER_ID", "1103328999528818");
  vi.stubEnv("META_SYSTEM_USER_TOKEN", "tok");
  vi.stubEnv("META_GRAPH_VERSION", "v22.0");
}

function stubFetch(resposta: unknown, ok = true) {
  const spy = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 400,
    json: async () => resposta,
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  sessaoNoBanco.token = null;
});

describe("adapter meta_cloud — endereçamento", () => {
  it("telefone vira E.164 em DÍGITOS, sem + e sem sufixo", () => {
    // `@c.us` é do outro canal. Um `+` sobrevivente vira (#131009) na Meta.
    expect(a().resolveRecipient({
      isGroup: false, groupChatId: null, phoneNumber: "+55 (31) 99896-6398", waIdentity: null,
    })).toBe("5531998966398");
  });

  it("grupo devolve null — a API de grupos não faz parte deste seam", () => {
    expect(a().resolveRecipient({
      isGroup: true, groupChatId: "123@g.us", phoneNumber: "+5531999998888", waIdentity: null,
    })).toBeNull();
  });

  it("sem telefone devolve null — não há `lid` neste canal", () => {
    expect(a().resolveRecipient({
      isGroup: false, groupChatId: null, phoneNumber: null, waIdentity: "lid:12345",
    })).toBeNull();
  });
});

describe("adapter meta_cloud — configuração", () => {
  it("sem credencial NÃO está configurado", () => {
    vi.stubEnv("META_PHONE_NUMBER_ID", "");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "");
    expect(a().isConfigured()).toBe(false);
  });

  it("com credencial está configurado", () => {
    configurar();
    expect(a().isConfigured()).toBe(true);
  });

  it("não configurado é NOOP no envio, nunca exceção", async () => {
    // Mesmo contrato do outro canal: a UI mostra banner, o handler grava `queued`.
    vi.stubEnv("META_PHONE_NUMBER_ID", "");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "");
    const r = await a().send({ organizationId: ORG, sessionRef: "x", to: "5531999", kind: "text", body: "oi" });
    expect(r).toEqual({ externalId: null });
  });

  it("os códigos carregam o nome do provider — por isso vivem no adapter", () => {
    expect(a().codes.notConfigured).toContain("meta");
    expect(a().codes.sendFailed).toContain("meta");
  });
});

describe("adapter meta_cloud — envio", () => {
  it("texto vai como type:text e o phone_number_id entra na URL, não no corpo", async () => {
    configurar();
    const spy = stubFetch({ messages: [{ id: "wamid.T" }] });
    const r = await a().send({ organizationId: ORG, sessionRef: "ignorado", to: "5531998966398", kind: "text", body: "oi" });

    expect(r).toEqual({ externalId: "wamid.T" });
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toContain("/v22.0/1103328999528818/messages");
    const corpo = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(corpo).toMatchObject({ messaging_product: "whatsapp", to: "5531998966398", type: "text" });
    expect(corpo).not.toHaveProperty("session");
  });

  it("áudio leva voice:true — sem isso vira anexo de música, não nota de voz", async () => {
    configurar();
    const spy = stubFetch({ messages: [{ id: "wamid.A" }] });
    await a().send({
      organizationId: ORG, sessionRef: "x", to: "5531998966398", kind: "audio",
      media: { url: "https://x/a.ogg", mime: "audio/ogg" },
    });
    const corpo = JSON.parse(spy.mock.calls[0]![1].body as string) as {
      type: string; audio: { link: string; voice: boolean };
    };
    expect(corpo.type).toBe("audio");
    expect(corpo.audio.voice).toBe(true);
  });

  it("imagem leva caption; documento leva filename", async () => {
    configurar();
    const spy = stubFetch({ messages: [{ id: "wamid.I" }] });
    await a().send({
      organizationId: ORG, sessionRef: "x", to: "5531", kind: "image",
      media: { url: "https://x/a.jpg", mime: "image/jpeg", caption: "olha" },
    });
    expect(JSON.parse(spy.mock.calls[0]![1].body as string).image).toEqual({
      link: "https://x/a.jpg", caption: "olha",
    });

    const spy2 = stubFetch({ messages: [{ id: "wamid.D" }] });
    await a().send({
      organizationId: ORG, sessionRef: "x", to: "5531", kind: "document",
      media: { url: "https://x/a.pdf", mime: "application/pdf", filename: "contrato.pdf" },
    });
    expect(JSON.parse(spy2.mock.calls[0]![1].body as string).document).toMatchObject({
      filename: "contrato.pdf",
    });
  });

  it("erro da Meta lança com o `details`, que diz QUAL parâmetro divergiu", async () => {
    configurar();
    stubFetch(
      {
        error: {
          code: 131009,
          message: "Parameter value is not valid",
          error_data: { details: "to: número em formato inválido" },
        },
      },
      false,
    );
    await expect(
      a().send({ organizationId: ORG, sessionRef: "x", to: "+5531", kind: "text", body: "oi" }),
    ).rejects.toThrow(/131009.*formato inválido/);
  });

  it("contato vai como type:contacts com formatted_name e wa_id", async () => {
    configurar();
    const spy = stubFetch({ messages: [{ id: "wamid.C" }] });
    const r = await a().send({
      organizationId: "org-1",
      sessionRef: "ignorado",
      to: "5531998966398",
      kind: "contact",
      contact: {
        fullName: "Maria Silva",
        phoneNumber: "+5511999887766",
        whatsappId: "5511999887766",
        vcard: "BEGIN:VCARD…",
      },
    });

    expect(r).toEqual({ externalId: "wamid.C" });
    const corpo = JSON.parse(spy.mock.calls[0]![1].body as string) as {
      type: string;
      contacts: Array<{ name: { formatted_name: string }; phones: Array<{ wa_id: string }> }>;
    };
    expect(corpo.type).toBe("contacts");
    expect(corpo.contacts[0]?.name.formatted_name).toBe("Maria Silva");
    expect(corpo.contacts[0]?.phones[0]?.wa_id).toBe("5511999887766");
  });

  it("resposta sem id devolve externalId null, sem estourar", async () => {
    configurar();
    stubFetch({ messages: [] });
    const r = await a().send({ organizationId: ORG, sessionRef: "x", to: "5531", kind: "text", body: "oi" });
    expect(r).toEqual({ externalId: null });
  });
});

describe("credencial por sessão — o que destrava multi-tenant", () => {
  it("com token na SESSÃO, o env deixa de valer", async () => {
    // Ordem sessão-primeiro: um env esquecido não pode silenciar o que foi
    // configurado pela tela, senão o operador não entende por que nada mudou.
    configurar();
    sessaoNoBanco.token = "token-da-sessao";
    const spy = stubFetch({ messages: [{ id: "wamid.S" }] });

    await a().send({ organizationId: ORG, sessionRef: "sessao-pn", to: "5531", kind: "text", body: "oi" });

    const [, init] = spy.mock.calls[0]!;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-da-sessao");
  });

  it("sem token na sessão, cai no env — instalação de número único segue funcionando", async () => {
    configurar();
    sessaoNoBanco.token = null;
    const spy = stubFetch({ messages: [{ id: "wamid.E" }] });

    await a().send({ organizationId: ORG, sessionRef: "qualquer", to: "5531", kind: "text", body: "oi" });

    const [, init] = spy.mock.calls[0]!;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });
});

/**
 * A MÍDIA QUE O CLIENTE MANDA — SEM URL NENHUMA NO WEBHOOK, SÓ O `media.id`.
 *
 * Ao contrário do canal intermediado (URL vem no payload do webhook), a Meta
 * exige DOIS passos autenticados: `GET /{media-id}` devolve a URL de verdade
 * (assinada, de vida curta), e só ela é buscada de fato — com o MESMO Bearer,
 * porque a Meta recusa essa URL sem autenticação (diferente de um link
 * público comum).
 *
 * `input.url` aqui é o `media.id`, nunca uma URL — é o que
 * `lib/channels/meta/ingest.ts` grava em `media_url` por não ter outra coisa
 * pra gravar (ver o comentário lá: "cada canal sabe o que fazer com ela").
 */
describe("adapter meta_cloud — fetchInboundMedia (mídia recebida)", () => {
  /**
   * Só arma o passo 1. Se o código sob teste chamar `fetch` uma 2ª vez sem
   * dever, o mock não tem mais resposta enfileirada e o `.json()`/`.headers`
   * do valor `undefined` estoura — falha ruidosa, mas falha. O que prende o
   * caso de verdade é sempre o `toHaveBeenCalledTimes(1)` ao lado.
   */
  function stubFetchPasso1(passo1: unknown, passo1Ok = true): ReturnType<typeof vi.fn> {
    const spy = vi
      .fn()
      .mockResolvedValueOnce({ ok: passo1Ok, status: passo1Ok ? 200 : 400, json: async () => passo1 });
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it("baixa em dois passos: metadado (com o media id na URL) e depois os bytes", async () => {
    configurar();
    const spy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ url: "https://graph.facebook.com/v22.0/assinada", mime_type: "image/jpeg" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(4),
        headers: new Headers({ "content-type": "image/jpeg" }),
      });
    vi.stubGlobal("fetch", spy);

    const r = await a().fetchInboundMedia!({
      organizationId: ORG,
      sessionRef: "1103328999528818",
      url: "1234567890",
    });

    expect(r.mime).toBe("image/jpeg");
    expect(spy).toHaveBeenCalledTimes(2);
    const [urlPasso1, initPasso1] = spy.mock.calls[0]!;
    expect(urlPasso1).toContain("/v22.0/1234567890");
    expect((initPasso1.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const [urlPasso2, initPasso2] = spy.mock.calls[1]!;
    expect(urlPasso2).toBe("https://graph.facebook.com/v22.0/assinada");
    // MESMO Bearer no passo 2 — sem ele a Meta devolve 401 nesta URL, ao
    // contrário de um link público comum.
    expect((initPasso2.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("sem credencial, lança SEM chamar fetch — a mídia não é ponto de exceção à regra", async () => {
    vi.stubEnv("META_PHONE_NUMBER_ID", "");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "");
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    await expect(
      a().fetchInboundMedia!({ organizationId: ORG, sessionRef: "x", url: "123" }),
    ).rejects.toThrow(/meta_not_configured/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("o passo 1 devolvendo erro da Graph API lança com a mensagem, sem tentar o passo 2", async () => {
    configurar();
    const spy = stubFetchPasso1(
      { error: { code: 190, message: "Error validating access token" } },
      false,
    );

    await expect(
      a().fetchInboundMedia!({ organizationId: ORG, sessionRef: "x", url: "123" }),
    ).rejects.toThrow(/Error validating access token/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  /**
   * DEFESA EM PROFUNDIDADE: mesmo a URL vindo da PRÓPRIA Meta (resposta do
   * passo 1, nunca do payload do webhook) passa pela mesma guarda de SSRF que
   * o resto do repo usa pra URL de fora. Uma resposta inesperada não é motivo
   * pra pular a checagem.
   */
  it("recusa baixar de um host privado mesmo que tenha vindo na resposta do passo 1", async () => {
    configurar();
    const spy = stubFetchPasso1({
      url: "http://169.254.169.254/latest/meta-data/",
      mime_type: "image/jpeg",
    });

    await expect(
      a().fetchInboundMedia!({ organizationId: ORG, sessionRef: "x", url: "123" }),
    ).rejects.toThrow();
    expect(spy, "o passo 2 não pode rodar sobre um host privado").toHaveBeenCalledTimes(1);
  });

  it("arquivo maior que o teto, anunciado no passo 1: recusa sem baixar o passo 2", async () => {
    configurar();
    const spy = stubFetchPasso1({
      url: "https://graph.facebook.com/v22.0/assinada",
      mime_type: "video/mp4",
      file_size: 52_428_800 + 1,
    });

    await expect(
      a().fetchInboundMedia!({ organizationId: ORG, sessionRef: "x", url: "123" }),
    ).rejects.toThrow(/exceeds/);
    expect(spy, "não precisava baixar pra saber que é grande demais").toHaveBeenCalledTimes(1);
  });

  it("arquivo maior que o teto, só anunciado no content-length do passo 2: recusa sem bufferizar", async () => {
    configurar();
    const spy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ url: "https://graph.facebook.com/v22.0/assinada", mime_type: "video/mp4" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => {
          throw new Error("não devia ter tentado ler o corpo");
        },
        headers: new Headers({ "content-length": String(52_428_800 + 1) }),
      });
    vi.stubGlobal("fetch", spy);

    await expect(
      a().fetchInboundMedia!({ organizationId: ORG, sessionRef: "x", url: "123" }),
    ).rejects.toThrow(/exceeds/);
  });

  it("o content-type da resposta manda sobre o mime_type do passo 1", async () => {
    configurar();
    const spy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ url: "https://graph.facebook.com/v22.0/assinada", mime_type: "application/octet-stream" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(2),
        headers: new Headers({ "content-type": "audio/ogg" }),
      });
    vi.stubGlobal("fetch", spy);

    const r = await a().fetchInboundMedia!({ organizationId: ORG, sessionRef: "x", url: "123" });
    expect(r.mime).toBe("audio/ogg");
  });
});
