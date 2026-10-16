/**
 * O diálogo de criar negócio ganhou os campos de `crm_pipelines.settings.fields`
 * — o mesmo catálogo que o dossiê (`LeadFieldsForm`) já editava depois de criado,
 * agora também na hora de criar (estilo Kommo).
 *
 * Sem `fieldDefs`, nada muda: a seção não aparece e `custom_fields` não entra
 * no corpo do POST — é assim que o painel do Inbox, que ainda não passa essa
 * prop, continua funcionando sem quebrar.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NewLeadDialog } from "@/components/kanban/NewLeadDialog";
import type { CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import type { Stage } from "@/lib/kanban/types";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ currency: "BRL", country: null }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
// SeletorDeContato chama useContactList — fora do escopo deste teste.
vi.mock("@/components/kanban/SeletorDeContato", () => ({
  SeletorDeContato: () => null,
}));

const STAGES: Stage[] = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Entrada", is_won: false, is_lost: false, is_archived: false } as Stage,
];

const CAMPOS: CustomFieldDef[] = [
  { key: "setor_cliente", label: "Setor do cliente", type: "select", options: [
    { value: "varejo_ecommerce", label: "Varejo e e-commerce" },
  ]},
  { key: "empresa_nome", label: "Empresa", type: "text" },
];

function envolver(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ data: { id: "lead-1" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function corpoEnviado() {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(init.body as string);
}

describe("NewLeadDialog · campos do pipeline", () => {
  it("⭐ sem fieldDefs, a seção não aparece e custom_fields fica fora do corpo", async () => {
    const user = userEvent.setup();
    envolver(
      <NewLeadDialog open onOpenChange={vi.fn()} pipelineId="22222222-2222-4222-8222-222222222222" stages={STAGES} />,
    );
    expect(screen.queryByLabelText("Setor do cliente")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Título"), "Negócio sem campos extras");
    await user.click(screen.getByRole("button", { name: "Criar lead" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(corpoEnviado()).not.toHaveProperty("custom_fields");
  });

  it("⭐ com fieldDefs, preencher um campo manda custom_fields no corpo", async () => {
    const user = userEvent.setup();
    envolver(
      <NewLeadDialog
        open
        onOpenChange={vi.fn()}
        pipelineId="22222222-2222-4222-8222-222222222222"
        stages={STAGES}
        fieldDefs={CAMPOS}
      />,
    );

    await user.type(screen.getByLabelText("Título"), "Loja nova");
    await user.type(screen.getByLabelText("Empresa"), "Acme Ltda");
    await user.click(screen.getByRole("button", { name: "Criar lead" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(corpoEnviado().custom_fields).toEqual({ empresa_nome: "Acme Ltda" });
  });

  it("limpa os campos personalizados depois de criar com sucesso", async () => {
    const user = userEvent.setup();
    envolver(
      <NewLeadDialog
        open
        onOpenChange={vi.fn()}
        pipelineId="22222222-2222-4222-8222-222222222222"
        stages={STAGES}
        fieldDefs={CAMPOS}
      />,
    );

    await user.type(screen.getByLabelText("Título"), "Loja nova");
    await user.type(screen.getByLabelText("Empresa"), "Acme Ltda");
    await user.click(screen.getByRole("button", { name: "Criar lead" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect((screen.getByLabelText("Empresa") as HTMLInputElement).value).toBe("");
  });
});
