/**
 * O DEBOUNCE DA BUSCA DO INBOX CONTRA UM FILTRO TROCADO NO MEIO DO CAMINHO.
 *
 * Achado no changelog do upstream: trocar de aba (ou qualquer outro filtro)
 * ENQUANTO um debounce de busca está pendente. Este arquivo só REPRODUZ —
 * não corrige. Se a corrida abaixo realmente atropelar um filtro, o item
 * some da Onda 1 e volta como item dedicado na Onda 3, com fix de verdade;
 * se o teste ficar verde de cara, a suspeita do changelog não se confirma
 * nesta base e o item fecha aqui mesmo.
 *
 * ─── Por que suspeitar, mesmo sem ver o bug rodar ainda ─────────────────────
 *
 * `InboxFilters.tsx`: `searchInput` é estado LOCAL, iniciado uma vez de
 * `value.search`. O debounce (`useEffect`, dep só `[searchInput]`,
 * `eslint-disable react-hooks/exhaustive-deps` deliberado) agenda
 * `onChange({ ...value, search: searchInput })` 250ms depois — e a `value`
 * daquele `onChange` é a que existia no RENDER em que o timer foi criado,
 * não a mais recente. Se outro filtro (aba, "Não lidos", canal, etiqueta)
 * mudar nesses 250ms, o `value` capturado fica desatualizado, e quando o
 * timer finalmente dispara ele reconstrói o objeto inteiro a partir desse
 * instantâneo velho — potencialmente devolvendo ao ar um campo que o
 * usuário já tinha mudado.
 *
 * ─── O que este teste achou (rodado antes de qualquer fix) ──────────────────
 *
 * A corrida é REAL: ligar "Não lidos" 100ms depois de digitar, e deixar o
 * debounce da busca terminar de disparar aos 250ms, faz `onlyUnread` voltar
 * para `false` — o debounce sobrescreve o toggle com o instantâneo velho.
 * Por doutrina desta base (`Onda 1 não muda comportamento fora do pontual
 * já mapeado`), o fix fica para a Onda 3, não aqui. `it.fails` é a forma
 * correta de registrar um bug CONHECIDO e AINDA NÃO CORRIGIDO num teste: a
 * suíte fica verde enquanto o bug existir, e ACUSARIA (teste passando onde
 * devia falhar) se alguém corrigisse o comportamento em outro lugar sem
 * atualizar este arquivo — sinal para promover `it.fails` de volta a `it`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import { InboxFilters, type InboxFiltersValue } from "@/components/inbox/InboxFilters";
import type * as CanaisModule from "@/hooks/channels/useChannelSessions";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { orgId: "org-1", name: "Org", role: "manager", visibility_mode: "all" } }),
}));
vi.mock("@/hooks/channels/useChannelSessions", async (original) => {
  const real = await original<typeof CanaisModule>();
  return { ...real, useChannelSessions: () => ({ data: [] }) };
});
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({ data: { unassigned: 0, mine: 0, all: 0 } }),
}));

const V0: InboxFiltersValue = { tab: "unassigned", search: "", onlyUnread: false };

/**
 * Reproduz exatamente a amarração de `InboxLayout.tsx`: `value` é estado do
 * PAI, `onChange` substitui o objeto inteiro — o mesmo contrato que o
 * componente real usa (`setFilterValue`/`aux`).
 */
function Wrapper({ onEveryChange }: { onEveryChange: (v: InboxFiltersValue) => void }) {
  const [value, setValue] = useState<InboxFiltersValue>(V0);
  return (
    <InboxFilters
      value={value}
      onChange={(next) => {
        setValue(next);
        onEveryChange(next);
      }}
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("busca com debounce vs. troca de filtro no meio do caminho", () => {
  // BUG CONHECIDO, NÃO CORRIGIDO NESTA ONDA — ver o cabeçalho do arquivo.
  it.fails('digitar, trocar "Não lidos" antes do debounce, e deixar o timer disparar', () => {
    const historico: InboxFiltersValue[] = [];
    render(<Wrapper onEveryChange={(v) => historico.push(v)} />);

    // 1) Digita — arma o debounce de 250ms com `value` = { onlyUnread: false, ... }.
    fireEvent.change(screen.getByLabelText("Buscar conversas"), {
      target: { value: "maria" },
    });

    // 2) ANTES do debounce disparar, liga "Não lidos" — isto é síncrono e
    //    imediato (não passa pelo debounce).
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.click(screen.getByRole("button", { name: "Não lidos" }));

    // 3) Deixa o debounce da busca terminar de disparar.
    act(() => {
      vi.advanceTimersByTime(250);
    });

    const final = historico[historico.length - 1]!;
    expect(final.search).toBe("maria");
    // A afirmação que importa: "Não lidos", ligado no passo 2, PRECISA
    // continuar ligado depois que o debounce da busca assentar por cima.
    expect(final.onlyUnread).toBe(true);
  });
});
