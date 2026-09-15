import { describe, expect, it } from "vitest";
import { podeEncerrar, type VoiceCallRow } from "./calls";

function chamada(overrides: Partial<VoiceCallRow> = {}): VoiceCallRow {
  return {
    id: "call-1",
    organizationId: "org-1",
    contactId: null,
    wacallsCallId: "wacalls-call-1",
    direction: "inbound",
    peerPhone: "+5511999999999",
    status: "ringing",
    endReason: null,
    startedAt: new Date().toISOString(),
    answeredAt: null,
    endedAt: null,
    durationMs: null,
    ownerUserId: null,
    createdBy: null,
    ...overrides,
  };
}

describe("lib/wacalls/calls — podeEncerrar", () => {
  it("chamada já encerrada: ninguém pode encerrar de novo", () => {
    expect(podeEncerrar(chamada({ status: "ended", ownerUserId: "user-a" }), "user-a")).toBe(false);
  });

  it("chamada sem dono ainda (inbound tocando): qualquer agent+ pode encerrar", () => {
    expect(podeEncerrar(chamada({ ownerUserId: null }), "qualquer-user")).toBe(true);
  });

  it("chamada com dono: só o dono pode encerrar", () => {
    const c = chamada({ status: "connected", ownerUserId: "user-a" });
    expect(podeEncerrar(c, "user-a")).toBe(true);
    expect(podeEncerrar(c, "user-b")).toBe(false);
  });
});
