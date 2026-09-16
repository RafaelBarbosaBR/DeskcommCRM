import { describe, expect, it } from "vitest";

import { loadInboundBodyForJob } from "@/lib/agent-engine/agent/inbound-turn";
import type { Queryable } from "@/lib/agent-engine/queue/queue";

/**
 * O AGENTE NÃO PODE DIZER "MENSAGEM VAZIA" QUANDO TEM ÁUDIO/FOTO COM
 * TRANSCRIÇÃO JÁ GRAVADA.
 *
 * Achado no changelog upstream (Onda 2, item 2.4): `loadInboundBodyForJob`
 * lia só a coluna `body` crua e caía em `row.body ?? ''` — mídia sem legenda
 * tem `body=''` (STRING VAZIA, nunca `null`), então o `??` nunca ativava o
 * fallback, e o turno chegava ao agente com corpo "" mesmo tendo uma
 * transcrição pronta em `media_derived_text`. `get-lead-context.ts` já tinha
 * a lógica certa (`deriveMessageBody`/`frameMediaBody`) — agora as duas rotas
 * usam a MESMA função.
 */

function fakeDb(row: Record<string, unknown> | undefined): Queryable {
  return {
    query: async () => ({
      rows: row === undefined ? [] : [row],
      rowCount: row === undefined ? 0 : 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    } as never),
  };
}

const INPUT = { tenantId: "org-1", conversationId: "conv-1", inboundMessageId: "msg-1" };

describe("loadInboundBodyForJob — mídia sem legenda com transcrição", () => {
  it("áudio sem legenda (body='') com transcrição gravada: o corpo NÃO fica vazio", async () => {
    const db = fakeDb({
      type: "audio",
      body: "",
      media_url: "https://x/audio.ogg",
      media_storage_path: "p/audio.ogg",
      media_derived_text: "quero agendar para amanhã às 10h",
    });

    const corpo = await loadInboundBodyForJob(db, INPUT);

    expect(corpo).not.toBe("");
    expect(corpo).not.toBeNull();
    expect(corpo).toContain("quero agendar para amanhã às 10h");
  });

  it("imagem sem legenda (body=null) e sem transcrição: cai no marcador [tipo], não em vazio", async () => {
    const db = fakeDb({
      type: "image",
      body: null,
      media_url: "https://x/foto.jpg",
      media_storage_path: "p/foto.jpg",
      media_derived_text: null,
    });

    const corpo = await loadInboundBodyForJob(db, INPUT);

    expect(corpo).toBe("[image]");
  });

  it("texto puro continua exatamente como antes", async () => {
    const db = fakeDb({
      type: "text",
      body: "oi, tudo bem?",
      media_url: null,
      media_storage_path: null,
      media_derived_text: null,
    });

    const corpo = await loadInboundBodyForJob(db, INPUT);

    expect(corpo).toBe("oi, tudo bem?");
  });

  it("mensagem não encontrada continua null (contrato preservado)", async () => {
    const corpo = await loadInboundBodyForJob(fakeDb(undefined), INPUT);
    expect(corpo).toBeNull();
  });
});
