/**
 * O VISTO AZUL AO RESPONDER — issue #2981, fatia 1.
 *
 * ─── O defeito, visto de fora do CRM ───────────────────────────────────────
 *
 * O agente (ou o atendente) responde, a resposta chega, e a mensagem que o
 * cliente MANDOU continua sem o segundo traço: entregue, nunca lida. Do lado de
 * lá isso soa como "me respondeu sem ler?" — o visto é o sinal de que tem gente
 * ali, e sem ele a conversa parece de robô mesmo quando a resposta é boa. Não
 * havia uma chamada de `sendSeen` em lugar nenhum do código.
 *
 * ─── Por que o cliente e o fetch são REAIS aqui ────────────────────────────
 *
 * `globalThis.fetch` é dublado e o `WahaClient` é o de verdade, montado a partir
 * do env: o que este teste precisa afirmar é o PEDIDO que sai pela rede —
 * caminho, verbo, corpo e endereço — e que ele sai DEPOIS do envio. Um dublê do
 * cliente inteiro ficaria verde com o caminho errado (`/api/{session}/sendSeen`,
 * que é a família de presença, não a de envio) e com o `chatId` não resolvido.
 *
 * ─── As duas metades do critério ───────────────────────────────────────────
 *
 * "A marcação acontece no caminho de envio" E "a resposta continua sendo
 * enviada quando ela falha". A segunda é a que mais se perde num refactor: basta
 * alguém trocar o `try/catch` do helper por `await` cru para a resposta passar a
 * depender de um recibo de leitura.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { getAdapter } from "@/lib/channels";
import type { OutboundEnvelope } from "@/lib/channels/types";
import { logger } from "@/lib/logger";
import { limparMemoCheckExists } from "@/lib/waha/resolve-contact-whatsapp-id";

const ORG = "00000000-0000-4000-8000-000000002981";
const WAHA_BASE = "http://localhost:3030";

interface Pedido {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/**
 * Sobe o WAHA "configurado" e devolve o diário de pedidos, na ordem em que
 * saíram. `status`: o que responder para o `/api/sendSeen` (o resto é 200).
 */
function stubWaha(opcoes: {
  resposta?: unknown;
  statusDoVisto?: number;
  checkExists?: (phone: string) => { numberExists: boolean; pn?: string; chatId?: string };
} = {}) {
  vi.stubEnv("WAHA_API_BASE_URL", WAHA_BASE);
  vi.stubEnv("WAHA_API_KEY", "hash123");
  const pedidos: Pedido[] = [];
  const fetchMock = vi.fn().mockImplementation((url: unknown, init?: RequestInit) => {
    const href = String(url);
    const cru = typeof init?.body === "string" ? init.body : null;
    pedidos.push({
      url: href,
      method: init?.method ?? "GET",
      body: cru ? (JSON.parse(cru) as Record<string, unknown>) : null,
    });
    if (href.includes("/api/sendSeen")) {
      return Promise.resolve(new Response("{}", { status: opcoes.statusDoVisto ?? 200 }));
    }
    if (href.includes("/api/contacts/check-exists")) {
      const phone = new URL(href).searchParams.get("phone") ?? "";
      const body = opcoes.checkExists?.(phone) ?? { numberExists: true, chatId: `${phone}@c.us` };
      return Promise.resolve(Response.json(body));
    }
    return Promise.resolve(Response.json(opcoes.resposta ?? { id: { _serialized: "ABC123" } }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return pedidos;
}

const envio = (to: string, extra: Partial<OutboundEnvelope> = {}) =>
  getAdapter("waha").send({
    organizationId: ORG,
    sessionRef: "default",
    to,
    kind: "text",
    body: "oi",
    ...extra,
  });

const doVisto = (pedidos: Pedido[]) => pedidos.filter((p) => p.url.includes("/api/sendSeen"));
const doTexto = (pedidos: Pedido[]) => pedidos.filter((p) => p.url.includes("/api/sendText"));

afterEach(() => {
  limparMemoCheckExists();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** O visto não segura o retorno: a falha dele aparece DEPOIS, no log. */
const warnDoVisto = () =>
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);

describe("o visto azul ao responder (#2981)", () => {
  it("a conversa é marcada como lida — POST /api/sendSeen, com a sessão no CORPO", async () => {
    const pedidos = stubWaha();

    await envio("5531999998888@c.us");

    const visto = doVisto(pedidos);
    expect(visto, "nenhuma marcação de leitura saiu no envio").toHaveLength(1);
    expect(visto[0]!.url).toBe(`${WAHA_BASE}/api/sendSeen`);
    expect(visto[0]!.method).toBe("POST");
    // A sessão vai no corpo, como em `sendText` — não no caminho, como a
    // família de presença. Sem `messageIds`: o pedido é a CONVERSA, não uma
    // mensagem específica (só o webhook conhece esses ids).
    expect(visto[0]!.body).toEqual({ session: "default", chatId: "5531999998888@c.us" });
  });

  it("marca DEPOIS de enviar: a resposta não espera o recibo de leitura", async () => {
    const pedidos = stubWaha();

    await envio("5531999998888@c.us");

    const caminho = pedidos
      .filter((p) => p.url.includes("/api/sendText") || p.url.includes("/api/sendSeen"))
      .map((p) => (p.url.includes("/api/sendText") ? "texto" : "visto"));
    expect(caminho).toEqual(["texto", "visto"]);
  });

  it("marca o MESMO endereço resolvido do envio (o @lid que o check-exists devolveu)", async () => {
    const pedidos = stubWaha({
      checkExists: () => ({ numberExists: true, chatId: "23423462304912@lid", pn: "5532984793302@c.us" }),
    });

    await envio("5532984793302@c.us");

    // O CRM endereça por telefone e o WhatsApp responde pelo @lid: marcar o
    // telefone deixaria sem visto exatamente a conversa que foi respondida.
    expect(doTexto(pedidos).at(-1)!.body?.chatId).toBe("23423462304912@lid");
    expect(doVisto(pedidos).at(-1)!.body?.chatId).toBe("23423462304912@lid");
  });

  it("mídia também marca — o visto não é enfeite do caminho de texto", async () => {
    const pedidos = stubWaha({ resposta: { key: { id: "VOICE1" } } });

    await envio("5531999998888@c.us", {
      kind: "audio",
      body: undefined,
      media: { url: "https://x/a.ogg", mime: "audio/ogg" },
    });

    expect(pedidos.some((p) => p.url.includes("/api/sendVoice"))).toBe(true);
    expect(doVisto(pedidos)).toHaveLength(1);
  });

  it("visto que FALHA (500) não derruba a resposta, e a resposta é a de sempre", async () => {
    const pedidos = stubWaha({ statusDoVisto: 500 });
    const warn = warnDoVisto();

    await expect(envio("5531999998888@c.us")).resolves.toEqual({ externalId: "ABC123" });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("não marcada como lida"),
        { organization_id: ORG, detail: "waha_500" },
      ),
    );

    // As duas metades de novo, no MESMO caso: tentou marcar e a mensagem saiu.
    expect(doVisto(pedidos)).toHaveLength(1);
    expect(doTexto(pedidos).at(-1)!.body).toEqual({
      session: "default",
      chatId: "5531999998888@c.us",
      text: "oi",
    });
  });

  it("visto que EXPLODE na rede (fetch rejeitado) também não derruba a resposta", async () => {
    vi.stubEnv("WAHA_API_BASE_URL", WAHA_BASE);
    vi.stubEnv("WAHA_API_KEY", "hash123");
    let vistoTentado = false;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: unknown) =>
        String(url).includes("/api/sendSeen")
          ? ((vistoTentado = true), Promise.reject(new TypeError("fetch failed")))
          : Promise.resolve(Response.json({ id: { _serialized: "ABC123" } })),
      ),
    );

    const warn = warnDoVisto();

    await expect(envio("5531999998888@c.us")).resolves.toEqual({ externalId: "ABC123" });
    expect(vistoTentado, "o caminho do visto não foi exercitado").toBe(true);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("não marcada como lida"),
        expect.objectContaining({ organization_id: ORG }),
      ),
    );
  });

  // Quem chama só grava o `external_id` depois que o `send` volta, e o
  // `message.ack` do webhook acha a linha SÓ por esse id. Um visto que segurasse
  // o retorno abriria a janela em que o ack de "entregue" se perde.
  it("sendSeen PENDURADO não segura o send: o externalId volta sem esperar o visto", async () => {
    vi.stubEnv("WAHA_API_BASE_URL", WAHA_BASE);
    vi.stubEnv("WAHA_API_KEY", "hash123");
    let vistoTentado = false;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: unknown) =>
        String(url).includes("/api/sendSeen")
          ? ((vistoTentado = true), new Promise<Response>(() => undefined))
          : Promise.resolve(Response.json({ id: { _serialized: "ABC123" } })),
      ),
    );

    await expect(envio("5531999998888@c.us")).resolves.toEqual({ externalId: "ABC123" });
    expect(vistoTentado, "o visto nem chegou a sair").toBe(true);
  }, 2_000);

  it("resposta em GRUPO sai, mas sem visto: marcaria como lidas as mensagens dos outros", async () => {
    const pedidos = stubWaha();

    await expect(envio("120363000000000000@g.us")).resolves.toEqual({ externalId: "ABC123" });

    expect(doTexto(pedidos).at(-1)!.body?.chatId).toBe("120363000000000000@g.us");
    expect(doVisto(pedidos)).toHaveLength(0);
  });

  it("sem env do WAHA nada sai pela rede — nem o visto", async () => {
    vi.stubEnv("WAHA_API_BASE_URL", "");
    vi.stubEnv("WAHA_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(envio("5531999998888@c.us")).resolves.toEqual({ externalId: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * O contrato do MÉTODO, separado do comportamento do produto: `sendSeen` lança
 * `waha_<status>` como os vizinhos (`sendText`, `editMessage`, `setPresence`).
 * Se ele passasse a engolir por conta própria, o teste acima — que roda o
 * adapter inteiro — continuaria verde, e a decisão de falhar macio teria
 * migrado para dentro do cliente sem ninguém decidir isso.
 */
describe("WahaClient.sendSeen", () => {
  it("status de erro vira throw `waha_<status>`", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 503 })));
    const { WahaClient } = await import("@/lib/waha/client");

    await expect(new WahaClient(WAHA_BASE, "chave").sendSeen("s1", "1@c.us")).rejects.toThrow(
      "waha_503",
    );
  });
});
