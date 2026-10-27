/**
 * O RELATÓRIO DO LOTE DA INBOX CONCORDA EM NÚMERO — PT-BR E ESPANHOL (#2990).
 *
 * ─── O defeito, medido na tela ──────────────────────────────────────────────
 *
 * O verbo do toast era FIXO no plural (`t("fechadas")` / `t("atualizadas")`),
 * então a barra anunciava **"1 conversas fechadas"** e **"1 fechadas, 1
 * recusadas"**. É o mesmo defeito que o lote de Contatos corrigiu no #2913, com
 * a mesma régua: número 1 leva o singular, 0 e 2+ levam o plural.
 *
 * ─── Por que a língua entra no teste ────────────────────────────────────────
 *
 * Aqui NÃO se mocka o `t` por identidade (como no teste dos contatos): a chave
 * é resolvida pela MESMA tabela que o produto usa, `traduzir`, com o idioma
 * trocado pelo teste. Isso prende as duas coisas de uma vez — a concordância e
 * a existência da tradução: sem a entrada em espanhol, a chave volta em
 * português e a asserção de `es` reprova aqui, antes do gate de i18n.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

import {
  useBulkConversations,
  type AcaoEmLote,
  type RelatorioDoLote,
} from "@/hooks/inbox/useBulkConversations";

/** O idioma da tela, trocado por teste — a mesma resolução do provider. */
let idiomaDaTela: Idioma = "pt-BR";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({
  useT: () => (s: string) => traduzir(s, idiomaDaTela),
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: vi.fn() } }));

function relatorio(feitos: number, recusados: number, acao: AcaoEmLote): { data: RelatorioDoLote } {
  const resultados = [
    ...Array.from({ length: feitos }, (_, i) => ({ id: `f-${i}`, feito: true })),
    ...Array.from({ length: recusados }, (_, i) => ({
      id: `r-${i}`,
      feito: false,
      motivo: "Fora.",
    })),
  ];
  return {
    data: { acao, teto: 100, total: feitos + recusados, feitos, recusados, resultados },
  };
}

/** Roda o lote e devolve o texto que chegou à tela (sucesso ou aviso). */
async function rodar(
  feitos: number,
  recusados: number,
  acao: AcaoEmLote = "close",
): Promise<string | undefined> {
  vi.mocked(apiClient.post).mockResolvedValueOnce(relatorio(feitos, recusados, acao));
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useBulkConversations(), { wrapper });
  result.current.mutate({
    ids: ["x"],
    action: acao,
    ...(acao === "transfer" ? { to_user_id: "u" } : {}),
  });
  await waitFor(() =>
    expect(
      vi.mocked(toast.success).mock.calls.length + vi.mocked(toast.warning).mock.calls.length,
    ).toBeGreaterThan(0),
  );
  if (recusados === 0) return vi.mocked(toast.success).mock.calls[0]?.[0] as string | undefined;
  return vi.mocked(toast.warning).mock.calls[0]?.[0] as string | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  idiomaDaTela = "pt-BR";
});

describe("lote da Inbox em PT-BR — a chave é o próprio texto", () => {
  it("fechar UMA: sucesso no singular, sem contar conversas no plural", async () => {
    expect(await rodar(1, 0, "close")).toBe("1 conversa fechada.");
  });

  it("fechar 3: plural dos dois lados", async () => {
    expect(await rodar(3, 0, "close")).toBe("3 conversas fechadas.");
  });

  it("lote parcial de 1: singular dos DOIS lados — era '1 fechadas, 1 recusadas'", async () => {
    expect(await rodar(1, 1, "close")).toBe("1 fechada, 1 recusada.");
  });

  it("lote parcial de 2 e 3: plural dos dois lados", async () => {
    expect(await rodar(2, 3, "close")).toBe("2 fechadas, 3 recusadas.");
  });

  it("marcar como lida UMA: o verbo de então é 'atualizada', no singular", async () => {
    expect(await rodar(1, 0, "mark-read")).toBe("1 conversa atualizada.");
  });

  it("arquivar 4: plural", async () => {
    expect(await rodar(4, 0, "archive")).toBe("4 conversas atualizadas.");
  });

  it("lote parcial de 1 em 'atualizadas': '1 atualizada, 1 recusada'", async () => {
    expect(await rodar(1, 1, "pause-ai")).toBe("1 atualizada, 1 recusada.");
  });

  it("zero feito leva o plural, como em Contatos", async () => {
    expect(await rodar(0, 1, "reactivate-bot")).toBe("0 atualizadas, 1 recusada.");
  });
});

describe("lote da Inbox em espanhol — o mesmo número, a mesma língua", () => {
  beforeEach(() => {
    idiomaDaTela = "es";
  });

  it("fechar UMA: '1 conversación cerrada.'", async () => {
    expect(await rodar(1, 0, "close")).toBe("1 conversación cerrada.");
  });

  it("lote parcial de 1: singular também nas recusas", async () => {
    expect(await rodar(1, 1, "close")).toBe("1 cerrada, 1 rechazada.");
  });

  it("lote parcial de 2 e 3: plural", async () => {
    expect(await rodar(2, 3, "close")).toBe("2 cerradas, 3 rechazadas.");
  });

  it("transferir UMA: '1 conversación actualizada.'", async () => {
    expect(await rodar(1, 0, "transfer")).toBe("1 conversación actualizada.");
  });

  it("transferir 2 com 1 recusa: '2 actualizadas, 1 rechazada.'", async () => {
    expect(await rodar(2, 1, "transfer")).toBe("2 actualizadas, 1 rechazada.");
  });
});
