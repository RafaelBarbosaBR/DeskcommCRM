import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { TiposDeAgendamentoClient, type TipoRow } from "./_client";

/**
 * LEMBRETE MÚLTIPLO (Onda 3, item 3.2) — a lista repetível de "Lembretes
 * extra" dentro do formulário de edição de um tipo de agendamento.
 *
 * `PrazosDePresenca` é um irmão desta tela que faz a própria chamada — o
 * `apiClient.get` genérico abaixo cobre a dela também, sem precisar mockar
 * o componente inteiro.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

let client: QueryClient;

const TIPO: TipoRow = {
  id: "tipo-1",
  name: "Consulta",
  slug: "consulta",
  description: null,
  category: "consulta",
  duration_minutes: 30,
  location_kind: "in_person",
  location_details: null,
  default_owner_user_id: "user-1",
  requires_confirmation: false,
  is_active: true,
  reminder_enabled: true,
  reminder_minutes_before: 1440,
  additional_reminders: [60],
  pending_expiration_hours: 24,
};

function renderTela(tipos: TipoRow[] = [TIPO]) {
  return render(
    <QueryClientProvider client={client}>
      <IdiomaProvider locale="pt-BR">
        <TiposDeAgendamentoClient
          tiposIniciais={tipos}
          pessoas={[{ id: "user-1", papel: "agent", nome: "Ana" }]}
          podeEditar
          usuarioAtualId="user-1"
          podeConfigurarGoogle={false}
        />
      </IdiomaProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  api.get.mockResolvedValue({ data: { confirmation_delay_minutes: 60, unknown_protection_minutes: 60 } });
  api.patch.mockResolvedValue({ data: { id: TIPO.id } });
});

afterEach(() => {
  cleanup();
  client.clear();
});

function abrirEdicao() {
  fireEvent.click(screen.getByTestId(`editar-${TIPO.id}`));
  return screen.getByTestId(`form-editar-${TIPO.id}`);
}

describe("Lembretes extra — lista repetível", () => {
  it("carrega o tipo já com um lembrete extra existente", () => {
    renderTela();
    const form = abrirEdicao();
    const input = within(form).getByTestId(`editar-lembrete-extra-${TIPO.id}-0`);
    expect(input).toHaveValue(60);
  });

  it('"Adicionar outro lembrete" acrescenta uma linha nova, vazia por padrão', () => {
    renderTela();
    const form = abrirEdicao();
    fireEvent.click(within(form).getByRole("button", { name: "Adicionar outro lembrete" }));

    const linhas = within(form).getAllByTestId(new RegExp(`editar-lembrete-extra-${TIPO.id}-\\d+`));
    expect(linhas).toHaveLength(2);
  });

  it("salvar manda additional_reminders com os dois valores, na ordem das linhas", () => {
    renderTela();
    const form = abrirEdicao();
    fireEvent.click(within(form).getByRole("button", { name: "Adicionar outro lembrete" }));
    const linhas = within(form).getAllByTestId(new RegExp(`editar-lembrete-extra-${TIPO.id}-\\d+`));
    fireEvent.change(linhas[1]!, { target: { value: "120" } });

    fireEvent.click(within(form).getByTestId(`salvar-${TIPO.id}`));

    expect(api.patch).toHaveBeenCalledWith(
      "/api/v1/agenda/tipos",
      expect.objectContaining({ additional_reminders: [60, 120] }),
    );
  });

  it('"Remover" tira a linha, e o valor removido não vai no PATCH', () => {
    renderTela();
    const form = abrirEdicao();
    fireEvent.click(within(form).getByRole("button", { name: "Remover" }));
    expect(
      within(form).queryByTestId(`editar-lembrete-extra-${TIPO.id}-0`),
    ).not.toBeInTheDocument();

    fireEvent.click(within(form).getByTestId(`salvar-${TIPO.id}`));

    expect(api.patch).toHaveBeenCalledWith(
      "/api/v1/agenda/tipos",
      expect.objectContaining({ additional_reminders: [] }),
    );
  });

  it("lembrete DESLIGADO no submit: additional_reminders não vai no PATCH (não apaga o que já existe)", () => {
    renderTela();
    const form = abrirEdicao();
    fireEvent.click(within(form).getByTestId(`editar-lembrete-${TIPO.id}`)); // desliga

    fireEvent.click(within(form).getByTestId(`salvar-${TIPO.id}`));

    const chamada = api.patch.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(chamada).not.toHaveProperty("additional_reminders");
  });
});

describe("Prazo para confirmar (horas) — só existe quando o tipo exige confirmação", () => {
  it("tipo que NÃO exige confirmação não mostra o campo de prazo", () => {
    renderTela();
    const form = abrirEdicao();
    expect(within(form).queryByTestId(`editar-prazo-${TIPO.id}`)).not.toBeInTheDocument();
  });

  it("⭐ tipo que exige confirmação mostra o campo, já com o prazo salvo", () => {
    const tipoComConfirmacao: TipoRow = {
      ...TIPO,
      requires_confirmation: true,
      pending_expiration_hours: 6,
    };
    renderTela([tipoComConfirmacao]);
    const form = abrirEdicao();
    expect(within(form).getByTestId(`editar-prazo-${TIPO.id}`)).toHaveValue(6);
  });

  it("salvar manda pending_expiration_hours quando o campo foi alterado", () => {
    const tipoComConfirmacao: TipoRow = {
      ...TIPO,
      requires_confirmation: true,
      pending_expiration_hours: 6,
    };
    renderTela([tipoComConfirmacao]);
    const form = abrirEdicao();
    fireEvent.change(within(form).getByTestId(`editar-prazo-${TIPO.id}`), {
      target: { value: "12" },
    });

    fireEvent.click(within(form).getByTestId(`salvar-${TIPO.id}`));

    expect(api.patch).toHaveBeenCalledWith(
      "/api/v1/agenda/tipos",
      expect.objectContaining({ pending_expiration_hours: 12 }),
    );
  });
});
