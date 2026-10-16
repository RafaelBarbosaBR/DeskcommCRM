import { beforeEach, describe, expect, it, vi } from "vitest";

import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { processarWebhookApi4com } from "./events-bridge";

vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const ORG_ID = "org-1";
const VOICE_CALL_ID = "vc-1";
const LEAD_ID = "lead-1";
const CONTACT_ID = "contact-1";

type Row = Record<string, unknown>;

function fakeAdmin(voiceCall: Row | null) {
  const atualizado: Row[] = [];
  const row = voiceCall ? { ...voiceCall } : null;
  return {
    from: (table: string) => {
      if (table !== "voice_calls") throw new Error(`fakeAdmin: tabela inesperada ${table}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: row, error: null }),
              }),
            }),
          }),
        }),
        update: (patch: Row) => ({
          eq: async (_col: string, _id: string) => {
            atualizado.push(patch);
            if (row) Object.assign(row, patch);
            return { data: row, error: null };
          },
        }),
      };
    },
    __row: row,
    __updates: atualizado,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("webhook api4com → voice_calls + timeline", () => {
  it("channel-answer marca connected e answered_at, sem tocar a timeline", async () => {
    const admin = fakeAdmin({ id: VOICE_CALL_ID, lead_id: LEAD_ID, contact_id: CONTACT_ID, owner_user_id: "u1", status: "ringing", answered_at: null });
    const r = await processarWebhookApi4com(admin as never, ORG_ID, {
      type: "channel-answer",
      answered_at: "2026-10-16T12:00:00Z",
      metadata: { voice_call_id: VOICE_CALL_ID },
    });
    expect(r.ok).toBe(true);
    expect(admin.__updates[0]).toMatchObject({ status: "connected", answered_at: "2026-10-16T12:00:00Z" });
    expect(emitLeadActivity).not.toHaveBeenCalled();
  });

  it("channel-hangup DEPOIS de atendida grava voice_call (não voice_call_unanswered)", async () => {
    const admin = fakeAdmin({
      id: VOICE_CALL_ID,
      lead_id: LEAD_ID,
      contact_id: CONTACT_ID,
      owner_user_id: "u1",
      status: "connected",
      answered_at: "2026-10-16T12:00:00Z",
    });
    const r = await processarWebhookApi4com(admin as never, ORG_ID, {
      type: "channel-hangup",
      id: "provider-call-1",
      ended_at: "2026-10-16T12:05:00Z",
      duration: 300,
      metadata: { voice_call_id: VOICE_CALL_ID },
    });
    expect(r.ok).toBe(true);
    expect(emitLeadActivity).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ leadId: LEAD_ID, type: "voice_call", actor: { type: "user", id: "u1" } }),
    );
  });

  it("channel-hangup SEM nunca ter sido atendida grava voice_call_unanswered", async () => {
    const admin = fakeAdmin({
      id: VOICE_CALL_ID,
      lead_id: LEAD_ID,
      contact_id: CONTACT_ID,
      owner_user_id: null,
      status: "ringing",
      answered_at: null,
    });
    const r = await processarWebhookApi4com(admin as never, ORG_ID, {
      type: "channel-hangup",
      id: "provider-call-2",
      hangup_cause: "NO_ANSWER",
      metadata: { voice_call_id: VOICE_CALL_ID },
    });
    expect(r.ok).toBe(true);
    expect(emitLeadActivity).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ type: "voice_call_unanswered", actor: { type: "webhook_source", id: "api4com" } }),
    );
  });

  it("hangup repetido (já encerrada) é idempotente — não grava a timeline de novo", async () => {
    const admin = fakeAdmin({
      id: VOICE_CALL_ID,
      lead_id: LEAD_ID,
      contact_id: CONTACT_ID,
      owner_user_id: "u1",
      status: "ended",
      answered_at: "2026-10-16T12:00:00Z",
    });
    const r = await processarWebhookApi4com(admin as never, ORG_ID, {
      type: "channel-hangup",
      id: "provider-call-1",
      metadata: { voice_call_id: VOICE_CALL_ID },
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("ja_encerrada");
    expect(emitLeadActivity).not.toHaveBeenCalled();
    expect(admin.__updates).toHaveLength(0);
  });

  it("sem metadata.voice_call_id, não toca o banco", async () => {
    const admin = fakeAdmin(null);
    const r = await processarWebhookApi4com(admin as never, ORG_ID, { type: "channel-hangup" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("sem_voice_call_id");
    expect(emitLeadActivity).not.toHaveBeenCalled();
  });

  it("chamada sem lead_id grava voice_calls mas NÃO chama a timeline (não há onde gravar)", async () => {
    const admin = fakeAdmin({
      id: VOICE_CALL_ID,
      lead_id: null,
      contact_id: null,
      owner_user_id: "u1",
      status: "connected",
      answered_at: "2026-10-16T12:00:00Z",
    });
    const r = await processarWebhookApi4com(admin as never, ORG_ID, {
      type: "channel-hangup",
      metadata: { voice_call_id: VOICE_CALL_ID },
    });
    expect(r.ok).toBe(true);
    expect(admin.__updates[0]).toMatchObject({ status: "ended" });
    expect(emitLeadActivity).not.toHaveBeenCalled();
  });
});
