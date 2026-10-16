/**
 * O composer de comentário no topo da linha do tempo (16/10).
 *
 * Por que isto tem teste: o botão "Comentar" precisa ficar desabilitado com o
 * campo vazio (senão o endpoint recusaria com 422 e o usuário só veria um
 * toast de erro por ter clicado sem escrever nada) e Enter precisa enviar
 * mas Shift+Enter precisa SÓ quebrar linha — os dois comportamentos são
 * fáceis de inverter por acidente num `onKeyDown` e o sintoma (enviar cedo
 * demais, ou nunca enviar) não aparece em nenhum outro teste do dossiê.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.hoisted(() => vi.fn());
const showApiError = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError }));

import { ApiError } from "@/lib/api/types";
import { LeadNoteComposer } from "@/components/kanban/LeadNoteComposer";

const LEAD_ID = "lead-1";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("comentário manual na linha do tempo", () => {
  it("o botão Comentar começa desabilitado com o campo vazio", () => {
    render(<LeadNoteComposer leadId={LEAD_ID} />);
    expect(screen.getByRole("button", { name: "Comentar" })).toBeDisabled();
  });

  it("ao escrever e clicar, envia POST para /notes com o texto e limpa o campo", async () => {
    post.mockResolvedValueOnce({});
    const user = userEvent.setup();
    render(<LeadNoteComposer leadId={LEAD_ID} />);

    const campo = screen.getByPlaceholderText("Escreva um comentário sobre este negócio…");
    await user.type(campo, "Cliente pediu desconto.");
    await user.click(screen.getByRole("button", { name: "Comentar" }));

    expect(post).toHaveBeenCalledWith(`/api/v1/leads/${LEAD_ID}/notes`, {
      text: "Cliente pediu desconto.",
    });
    expect(campo).toHaveValue("");
  });

  it("Enter envia; Shift+Enter só quebra linha e não envia", async () => {
    post.mockResolvedValue({});
    const user = userEvent.setup();
    render(<LeadNoteComposer leadId={LEAD_ID} />);
    const campo = screen.getByPlaceholderText("Escreva um comentário sobre este negócio…");

    await user.type(campo, "primeira linha");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(campo, "segunda linha");
    expect(post).not.toHaveBeenCalled();
    expect(campo).toHaveValue("primeira linha\nsegunda linha");

    await user.keyboard("{Enter}");
    expect(post).toHaveBeenCalledWith(`/api/v1/leads/${LEAD_ID}/notes`, {
      text: "primeira linha\nsegunda linha",
    });
  });

  it("em erro de API, mostra o toast e MANTÉM o texto no campo", async () => {
    post.mockRejectedValueOnce(new ApiError("internal_error", "falhou", 500));
    const user = userEvent.setup();
    render(<LeadNoteComposer leadId={LEAD_ID} />);
    const campo = screen.getByPlaceholderText("Escreva um comentário sobre este negócio…");

    await user.type(campo, "não pode se perder");
    await user.click(screen.getByRole("button", { name: "Comentar" }));

    expect(await screen.findByRole("button", { name: "Comentar" })).not.toBeDisabled();
    expect(showApiError).toHaveBeenCalled();
    expect(campo).toHaveValue("não pode se perder");
  });
});
