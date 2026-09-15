import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { TestPanel } from "./TestPanel";
import type { AgentRow } from "@/hooks/ai/useAgent";
import type { AgentVersionRow } from "@/hooks/ai/useAgentVersions";

/**
 * "TESTAR AGENTE" PRECISA DE UM TIMEOUT MAIOR QUE O PADRÃO DO CLIENTE.
 *
 * Achado no changelog do upstream: sem `timeoutMs` explícito, a chamada
 * herdava os 10s padrão de `lib/api/client.ts` — curtos demais para uma
 * geração de LLM real (pior em cadeia de ferramentas) — e o timeout disparava
 * RETRY (`MAX_ATTEMPTS=3`). A rota `.../test` NÃO é idempotente: cada
 * tentativa insere uma `ai_agent_runs` nova E gasta crédito de novo — um
 * teste "lento, mas ia responder" virava três chamadas cobradas por um
 * clique só.
 */

const api = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));

const AGENT: AgentRow = {
  id: "agent-1",
  organization_id: "org-1",
  name: "Agente",
  description: null,
  model: "claude-sonnet-4-6",
  system_prompt: "",
  is_active: true,
  is_default: false,
  config: {},
  guardrails: null,
  active_kb_version_id: null,
};

const DRAFT: AgentVersionRow = {
  id: "version-1",
  organization_id: "org-1",
  agent_id: "agent-1",
  version_number: 1,
  system_prompt: "oi",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  credential_id: "cred-1",
  tool_ids: [],
  trigger_config: null,
  channel_session_id: "session-1",
  max_steps: 5,
  token_budget: 1000,
  cost_budget_cents: 100,
  history_message_window: 10,
  history_token_window: 4000,
  handoff_keywords: [],
  handoff_tool_enabled: false,
  cases_enabled: false,
  operator_enabled: false,
  status: "draft",
} as unknown as AgentVersionRow;

let client: QueryClient;

function renderTela() {
  return render(
    <QueryClientProvider client={client}>
      <IdiomaProvider locale="pt-BR">
        <TestPanel agent={AGENT} draft={DRAFT} published={null} />
      </IdiomaProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  api.post.mockResolvedValue({ data: { run_id: "run-1", status: "ok" } });
});

afterEach(() => {
  cleanup();
  client.clear();
});

describe('"Executar teste" manda um timeoutMs bem acima do padrão do cliente', () => {
  it("chama apiClient.post com timeoutMs configurado", async () => {
    renderTela();

    fireEvent.change(screen.getByLabelText("Mensagem do cliente (sample)"), {
      target: { value: "Oi, quanto custa?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Executar teste" }));

    await screen.findByText("run-1", { exact: false }).catch(() => undefined);

    expect(api.post).toHaveBeenCalledTimes(1);
    const [, , opts] = api.post.mock.calls[0]!;
    expect(opts).toMatchObject({ timeoutMs: expect.any(Number) });
    // O padrão do cliente é 10_000ms — o disparo do bug era herdar exatamente esse valor.
    expect((opts as { timeoutMs: number }).timeoutMs).toBeGreaterThan(10_000);
  });
});
