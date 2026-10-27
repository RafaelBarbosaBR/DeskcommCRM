/**
 * A CAIXA DE SELEÇÃO DESMARCADA DO LOTE DA INBOX É VISÍVEL NOS DOIS TEMAS (#2990).
 *
 * ─── O defeito, medido na tela ──────────────────────────────────────────────
 *
 * A borda da caixa DESMARCADA usava `border-input` — que resolve para
 * `--color-border` (`#e7e3da` no claro, `#33312a` no escuro). Contra o fundo da
 * coluna da lista isso dá **1,28:1 no claro e 1,31:1 no escuro**: o contorno da
 * caixa praticamente some, e com ele some a única pista de que a linha pode ser
 * marcada. A WCAG 1.4.11 (Non-text Contrast) pede 3:1 para o limite de um
 * controle — é o mesmo defeito que o lote de Contatos corrigiu no #2913, com a
 * MESMA troca de token (`border-muted-foreground`).
 *
 * ─── Por que medido a partir do CSS, e não do `getComputedStyle` ─────────────
 *
 * O jsdom não aplica Tailwind: `getComputedStyle` na caixa devolve vazio. Quem
 * mede aqui é `tests/setup/contraste-do-utilitario`, que segue a cadeia que a
 * classe nomeia (`border-muted-foreground` → `--color-muted-foreground` no
 * `@theme inline` → `--color-text-muted`) até o hex de cada tema em
 * `app/globals.css`.
 *
 * ─── As duas caixas, e as duas superfícies ──────────────────────────────────
 *
 * São dois controles distintos com o mesmo par de tokens: o "selecionar todas"
 * do cabeçalho (`ConversationList`) e a caixa de cada linha
 * (`ConversationListItem`). E a coluna da lista NÃO pinta superfície própria —
 * ela herda o fundo da página —, então a borda pode cair sobre `surface` ou
 * sobre `bg`: as duas entram na medida, em vez de escolher a mais folgada por
 * acidente.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { conversaDeExemplo } from "@/components/inbox/__fixtures__/conversa";
import type { ConversationsFilters } from "@/hooks/inbox/useConversationsRealtime";
import { contrasteNoTema, tokenDaClasse } from "@/tests/setup/contraste-do-utilitario";

// A lista pergunta o canal e o automático da organização; os dois hooks são de
// react-query, e aqui não há Provider para eles.
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
}));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({ useAutomaticoAtivo: () => ({ data: false }) }));

const { ConversationList } = await import("@/components/inbox/ConversationList");
const { ConversationListItem } = await import("@/components/inbox/ConversationListItem");

const TEMAS = ["claro", "escuro"] as const;
/** Piso da WCAG 1.4.11 para o limite de um controle. */
const PISO_DO_CONTROLE = 3;

function listaFalsa() {
  return {
    data: { pages: [{ data: [conversaDeExemplo.conversation] }] },
    isPending: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  } as never;
}

/** Mede a borda da caixa contra as duas superfícies em que ela pode cair. */
function conferirBorda(caixa: HTMLElement, onde: string) {
  const borda = tokenDaClasse(caixa.className, "border");
  for (const tema of TEMAS) {
    for (const fundo of ["surface", "background"] as const) {
      expect(
        contrasteNoTema(borda, fundo, tema),
        `${onde}: ${borda} sobre ${fundo} no ${tema}`,
      ).toBeGreaterThanOrEqual(PISO_DO_CONTROLE);
    }
  }
}

afterEach(() => cleanup());

describe("caixa de seleção do lote da Inbox — a borda desmarcada passa 3:1 (#2990)", () => {
  it("a caixa de cada linha, desmarcada", () => {
    render(
      <ConversationListItem
        conversation={conversaDeExemplo.conversation}
        {...conversaDeExemplo.props}
        selecionado={false}
        onAlternarSelecao={() => undefined}
      />,
    );
    conferirBorda(
      screen.getByTestId(`selecao-em-lote-${conversaDeExemplo.conversation.id}`),
      "linha",
    );
  });

  it('o "selecionar todas" do cabeçalho, desmarcado', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <ConversationList
          listQuery={listaFalsa()}
          filters={{} as ConversationsFilters}
          selectedId={null}
          onSelect={() => undefined}
          selecionados={new Set()}
          onAlternarSelecao={() => undefined}
          onSelecionarTodosVisiveis={() => undefined}
        />
      </QueryClientProvider>,
    );
    conferirBorda(screen.getByTestId("selecionar-todas-visiveis"), "cabeçalho");
  });
});
