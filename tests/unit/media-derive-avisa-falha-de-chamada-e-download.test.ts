/**
 * `avisarMidiaNaoLida` cobria só os 3 cenários PRÉ-CHAMADA (sem visão, sem
 * provedor no registro, sem chave OpenAI p/ transcrever). A falha REAL da
 * chamada — `generateText` devolvendo 401/404/timeout, ou o download do
 * storage falhando — caía no catch de fora do worker, virava só
 * `logger.error` na última tentativa, e a Central NUNCA abria. Para quem
 * instalou, o sintoma era indistinguível de "o agente ignora fotos" sem
 * nenhuma pista de por quê.
 *
 * Este arquivo prova os dois catches: usa o `deriveMediaText` REAL (não
 * mockado) para que a chamada chegue de fato a `describeImage`, e só troca o
 * `generateText` do SDK e o `download` do storage.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const downloadMock = vi.fn();
const updateMock = vi.fn();
const insertedAvisos: Array<Record<string, unknown>> = [];

const messageRow = {
  id: "msg1",
  organization_id: "org1",
  type: "image",
  media_mime: "image/jpeg",
  media_storage_path: "org1/conv1/msg1.jpg",
  media_derived_status: null as string | null,
};

function messagesTable() {
  const obj: Record<string, unknown> = {};
  obj.select = () => obj;
  obj.eq = () => obj;
  obj.maybeSingle = async () => ({ data: messageRow, error: null });
  obj.update = (patch: Record<string, unknown>) => {
    updateMock(patch);
    return { eq: () => ({ eq: async () => ({ error: null }) }) };
  };
  return obj;
}

function purposeBindingsTable() {
  const obj: Record<string, unknown> = {};
  obj.select = () => obj;
  obj.eq = () => obj;
  obj.maybeSingle = async () => ({ data: null, error: null });
  return obj;
}

/** Nunca há aviso já aberto neste arquivo: cada teste prova a ABERTURA. */
function agentInboxItemsTable() {
  const obj: Record<string, unknown> = {};
  obj.select = () => obj;
  obj.eq = () => obj;
  obj.limit = () => obj;
  obj.maybeSingle = async () => ({ data: null, error: null });
  obj.insert = (payload: Record<string, unknown>) => {
    insertedAvisos.push(payload);
    return Promise.resolve({ error: null });
  };
  return obj;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela === "messages") return messagesTable();
      if (tabela === "ai_purpose_bindings") return purposeBindingsTable();
      if (tabela === "agent_inbox_items") return agentInboxItemsTable();
      throw new Error(`tabela inesperada no dublê: ${tabela}`);
    },
    storage: { from: () => ({ download: downloadMock }) },
  }),
}));

vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({
  resolveOrgLlmConfig: vi.fn(async () => ({
    provider: "openai",
    apiKey: "sk-test",
    defaultModel: "gpt-5.6-terra",
    params: {},
    enabledModels: [],
    orcamento: { modo: "off", tetoCents: 0, efetivoEm: null, limiarPct: 80 },
    orcamentoIndisponivelPorque: null,
  })),
}));

const generateTextMock = vi.fn();
vi.mock("ai", () => ({ generateText: (...args: unknown[]) => generateTextMock(...args) }));

import { deriveMessageMedia } from "@/workers/media-derive-worker";

function eventRow(attempts = 0) {
  return {
    id: "ev1",
    organization_id: "org1",
    event_type: "media.derive_requested",
    entity_kind: "message",
    entity_id: "msg1",
    payload: { message_id: "msg1" },
    metadata: {},
    consumed_by: [],
    attempts,
  };
}

beforeEach(() => {
  downloadMock.mockReset();
  updateMock.mockReset();
  insertedAvisos.length = 0;
  messageRow.media_derived_status = null;
  generateTextMock.mockReset();
});

describe("falha de DOWNLOAD abre aviso na Central", () => {
  it("⭐ storage recusa o download: avisarMidiaNaoLida abre com o motivo do storage", async () => {
    downloadMock.mockResolvedValue({ data: null, error: { message: "object not found" } });

    const r = await deriveMessageMedia(eventRow());

    expect(r.status).toBe("error");
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(insertedAvisos).toHaveLength(1);
    expect(insertedAvisos[0]?.kind).toBe("midia_nao_lida");
    expect(insertedAvisos[0]?.title).toContain("imagem");
    expect(String(insertedAvisos[0]?.body)).toContain("object not found");
  });
});

describe("falha REAL da chamada de visão (generateText) abre aviso na Central", () => {
  it("⭐ 401 (chave recusada) vira frase que nomeia a chave, não 'modelo não liberado'", async () => {
    downloadMock.mockResolvedValue({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null });
    generateTextMock.mockRejectedValue(Object.assign(new Error("Unauthorized"), { statusCode: 401 }));

    const r = await deriveMessageMedia(eventRow());

    expect(r.status).toBe("error");
    expect(insertedAvisos).toHaveLength(1);
    expect(insertedAvisos[0]?.kind).toBe("midia_nao_lida");
    const corpo = String(insertedAvisos[0]?.body);
    expect(corpo).toContain("chave configurada foi recusada");
    expect(corpo).not.toContain("não está liberado");
  });

  it("404 (modelo não liberado/inexistente) vira frase DIFERENTE da de chave errada", async () => {
    downloadMock.mockResolvedValue({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null });
    generateTextMock.mockRejectedValue(Object.assign(new Error("model not found"), { statusCode: 404 }));

    const r = await deriveMessageMedia(eventRow());

    expect(r.status).toBe("error");
    const corpo = String(insertedAvisos[0]?.body);
    expect(corpo).toContain("não existe ou não está liberado");
    expect(corpo).not.toContain("chave configurada foi recusada");
  });

  it("timeout/indisponibilidade vira frase de 'tente novamente mais tarde'", async () => {
    downloadMock.mockResolvedValue({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null });
    generateTextMock.mockRejectedValue(new Error("fetch failed: ETIMEDOUT"));

    const r = await deriveMessageMedia(eventRow());

    expect(r.status).toBe("error");
    const corpo = String(insertedAvisos[0]?.body);
    expect(corpo).toContain("tente novamente mais tarde");
  });

  it("depois do aviso, a mensagem ainda cai em failed na última tentativa (mesmo comportamento de antes)", async () => {
    downloadMock.mockResolvedValue({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null });
    generateTextMock.mockRejectedValue(Object.assign(new Error("Unauthorized"), { statusCode: 401 }));

    await deriveMessageMedia(eventRow(4));

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ media_derived_status: "failed" }),
    );
  });
});
