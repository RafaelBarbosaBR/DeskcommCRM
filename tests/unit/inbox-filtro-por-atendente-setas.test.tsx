/**
 * Entrar em Minhas limpa o atendente escolhido pelo gerente por QUALQUER caminho.
 *
 * O clique na aba já limpava; as setas de "Aba anterior"/"Próxima aba" não. Por
 * elas, a escolha seguia viva em Minhas com o seletor escondido, e as outras
 * abas continuavam contando só o atendente escolhido sem nada na tela dizer isso.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InboxFilters, type InboxFiltersValue } from "@/components/inbox/InboxFilters";
import type { ActiveOrg } from "@/lib/auth/types";

const ATENDENTE = "bf49a9c8-9fbd-448c-8a94-4db4b14b7219";
const activeOrgRef: { current: ActiveOrg | null } = { current: null };

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: activeOrgRef.current }),
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
  channelLabel: () => "canal",
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({ data: {} }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));

// As setas só aparecem quando a faixa transborda: em jsdom a largura é 0, então
// a faixa é declarada mais larga que a janela dela.
beforeEach(() => {
  activeOrgRef.current = { orgId: "org-1", name: "Org", role: "manager", visibility_mode: "all" };
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => 1000 });
});
afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
});

const COM_ATENDENTE: InboxFiltersValue = { tab: "unassigned", search: "", onlyUnread: false, assigned_to: ATENDENTE };

describe("filtro por atendente — as setas de aba", () => {
  it("'Próxima aba' para Minhas limpa o atendente escolhido", () => {
    const onChange = vi.fn();
    render(<InboxFilters value={COM_ATENDENTE} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Próxima aba" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tab: "mine", assigned_to: undefined }));
  });

  it("CONTROLE: seta para uma aba que não é Minhas mantém a escolha", () => {
    const onChange = vi.fn();
    render(<InboxFilters value={{ ...COM_ATENDENTE, tab: "all" }} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Próxima aba" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tab: "closed", assigned_to: ATENDENTE }));
  });
});
