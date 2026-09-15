import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * O PAINEL DE SUGESTÃO NÃO FICA PRESO NUMA DECISÃO JÁ TOMADA.
 *
 * `query.data?.data.drafts[0]` sempre pega a sugestão MAIS RECENTE, sem olhar
 * o `status` — uma sugestão `dismissed` (rejeitada), `stale` (a conversa
 * mudou) ou `sent` (já enviada) continuava desenhando o painel inteiro:
 * textarea com o texto antigo, propostas, tudo — em vez de voltar para o
 * botão "Sugerir resposta". Rejeitar uma sugestão "travava a tela" nela
 * mesma, que é o defeito relatado.
 *
 * `failed` fica de fora do filtro DE PROPÓSITO: é a única sugestão que
 * carrega a pista do motivo, então continuar mostrando-a é o comportamento
 * certo, não uma exceção esquecida.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
  },
}));

const showApiErrorMock = vi.fn();
vi.mock("@/components/feedback/ApiErrorToast", () => ({
  showApiError: (...args: unknown[]) => showApiErrorMock(...args),
}));

import { ReplyReviewPanel } from "@/components/inbox/composer/ReplyReviewPanel";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { qc, node: <QueryClientProvider client={qc}>{ui}</QueryClientProvider> };
}

/**
 * Confirma que o FETCH já resolveu e o cache populou — não que o elemento
 * ainda não apareceu. `queryByLabelText(...).not.toBeInTheDocument()` passa
 * trivialmente ANTES da promise resolver (primeiro render, sem dado nenhum),
 * o que mediria "ainda não carregou" e não "carregou e ficou de fora" — a
 * armadilha que fez esta suíte passar mesmo com o filtro removido na primeira
 * tentativa. Esperar o cache é o sinal que não confunde os dois.
 */
async function aguardaCarregar(qc: QueryClient, conversationId: string) {
  await waitFor(() =>
    expect(qc.getQueryData(["reply-drafts", conversationId])).toBeDefined(),
  );
}

const DRAFT_ID = "draft-1";

function draftPayload(status: string) {
  return {
    data: {
      drafts: [
        {
          id: DRAFT_ID,
          revision: "1",
          status,
          original_body: "Olá, tudo bem?",
          edited_body: null,
          error_code: null,
          proposals: [],
        },
      ],
    },
  };
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  showApiErrorMock.mockReset();
});

describe("ReplyReviewPanel — status decidido não trava o painel na tela", () => {
  it.each([
    ["dismissed", "rejeitada"],
    ["stale", "obsoleta — a conversa mudou"],
    ["sent", "já enviada"],
  ])("status '%s' (%s): sem textarea presa, o botão de sugerir continua ali", async (status) => {
    getMock.mockResolvedValue(draftPayload(status));
    const { qc, node } = wrap(<ReplyReviewPanel conversationId="conv-1" />);
    render(node);

    await aguardaCarregar(qc, "conv-1");

    expect(screen.queryByLabelText("Resposta sugerida")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sugerir resposta" })).toBeInTheDocument();
  });

  it("status 'failed' CONTINUA aparecendo — é a única sugestão que carrega o motivo", async () => {
    getMock.mockResolvedValue(draftPayload("failed"));
    const { qc, node } = wrap(<ReplyReviewPanel conversationId="conv-1" />);
    render(node);

    await aguardaCarregar(qc, "conv-1");

    expect(
      screen.getByText("Confira a configuração do agente e tente gerar novamente."),
    ).toBeInTheDocument();
  });

  it("rejeitar: o aviso 'Sugestão rejeitada' aparece MESMO com o status virando 'dismissed'", async () => {
    getMock.mockResolvedValueOnce(draftPayload("pending")).mockResolvedValue(draftPayload("dismissed"));
    postMock.mockResolvedValue({});

    const { node } = wrap(<ReplyReviewPanel conversationId="conv-1" />);
    render(node);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Rejeitar" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Rejeitar" }));

    await waitFor(() =>
      expect(
        screen.getByText("Sugestão rejeitada. O feedback será usado na próxima sugestão."),
      ).toBeInTheDocument(),
    );
    // E o painel de revisão já não está mais preso na tela — só o aviso ficou.
    expect(screen.queryByLabelText("Resposta sugerida")).not.toBeInTheDocument();
  });
});
