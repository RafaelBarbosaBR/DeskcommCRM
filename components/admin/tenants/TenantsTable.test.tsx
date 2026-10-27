/**
 * Os atalhos da linha da listagem de tenants (#2778): três botões de ícone em
 * TODA linha, e o terceiro deles reage ao `status` que a própria linha já traz.
 *
 * Por que pela TABELA e não pelo componente de ações: a prova da issue é
 * "na listagem, toda linha tem os três botões". Testar o componente isolado
 * deixaria a regressão de montagem (alguém esquecer de renderizar as ações na
 * célula) passando em verde.
 *
 * A assimetria é o assunto: Acompanhar e Editar NAVEGAM (link, href conferível),
 * Suspender é AÇÃO com diálogo na própria lista — por isso este teste também
 * guarda que cancelar não dispara a mutation e que a linha segue na tela.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AdminTenantRow } from "@/hooks/useAdminTenants";

const { suspender } = vi.hoisted(() => ({ suspender: vi.fn() }));

vi.mock("@/hooks/useSuspendTenant", () => ({
  useSuspendTenant: () => ({ mutate: suspender, isPending: false }),
}));

import { TenantsTable } from "./TenantsTable";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function linha(parcial: Partial<AdminTenantRow>): AdminTenantRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "acme",
    display_name: "Acme",
    legal_name: null,
    cnpj: null,
    status: "active",
    onboarded_at: "2026-01-15T12:00:00.000Z",
    suspended_at: null,
    suspended_kind: null,
    created_at: "2026-01-01T12:00:00.000Z",
    user_count: [{ count: 3 }],
    conversations_count: [{ count: 12 }],
    ...parcial,
  };
}

function montar(...data: AdminTenantRow[]) {
  return render(
    <TenantsTable
      data={data}
      hasNextPage={false}
      isFetchingNextPage={false}
      onLoadMore={() => {}}
    />,
  );
}

// ---------------------------------------------------------------------------
// (a) Os três botões existem em toda linha, com aria-label e title em PT-BR
// ---------------------------------------------------------------------------

describe("atalhos da linha — os três botões", () => {
  it("aparecem em toda linha, cada um com aria-label e title em português", () => {
    montar(
      linha({}),
      linha({ id: "22222222-2222-4222-8222-222222222222", display_name: "Beta" }),
    );

    // Duas linhas × três botões — o "toda linha" da prova 1.
    expect(screen.getAllByLabelText(/^Acompanhar a saúde de /)).toHaveLength(2);
    expect(screen.getAllByLabelText(/^Editar os dados de /)).toHaveLength(2);
    expect(screen.getAllByLabelText(/^Suspender /)).toHaveLength(2);

    const acompanhamento = screen.getByLabelText("Acompanhar a saúde de Acme");
    expect(acompanhamento).toHaveAttribute("title", "Acompanhar a saúde de Acme");

    const edicao = screen.getByLabelText("Editar os dados de Acme");
    expect(edicao).toHaveAttribute("title", "Editar os dados de Acme");

    const suspensao = screen.getByLabelText("Suspender Acme");
    expect(suspensao).toHaveAttribute("title", "Suspender Acme");
    // Ícone só: o rótulo acessível é a ÚNICA coisa que o leitor de tela anuncia.
    expect(suspensao.tagName).toBe("BUTTON");
  });

  it("Acompanhar e Editar NAVEGAM: são links para a página certa do tenant", () => {
    montar(linha({}));

    const acompanhamento = screen.getByLabelText("Acompanhar a saúde de Acme");
    expect(acompanhamento).toHaveAttribute("href", "/admin/tenants/11111111-1111-4111-8111-111111111111/health");

    const edicao = screen.getByLabelText("Editar os dados de Acme");
    expect(edicao).toHaveAttribute("href", "/admin/tenants/11111111-1111-4111-8111-111111111111");
  });
});

// ---------------------------------------------------------------------------
// (b) O botão reage ao status: suspended → Reativar, e NUNCA Suspender
// ---------------------------------------------------------------------------

describe("o botão de ciclo de vida reage ao status da linha", () => {
  it("tenant suspenso mostra Reativar e não mostra Suspender", () => {
    montar(
      linha({
        id: "33333333-3333-4333-8333-333333333333",
        display_name: "Gama",
        status: "suspended",
        suspended_at: "2026-02-01T12:00:00.000Z",
      }),
    );

    expect(screen.getByLabelText(/Reativar/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Suspender/)).toBeNull();
  });

  it("suspensão por falta de pagamento NÃO oferece Reativar: o atalho leva à ficha", () => {
    // A rota /reactivate recusa esta com 409 `suspensao_de_cobranca`; a saída é
    // o card Cobrança da ficha (Dar prazo / Tornar isenta).
    montar(
      linha({
        id: "77777777-7777-4777-8777-777777777777",
        display_name: "Zeta",
        status: "suspended",
        suspended_at: "2026-02-01T12:00:00.000Z",
        suspended_kind: "cobranca",
      }),
    );

    expect(screen.queryByLabelText(/Reativar/)).toBeNull();
    expect(screen.queryByLabelText(/^Suspender/)).toBeNull();
    expect(screen.getByLabelText("Suspensa por falta de pagamento — Zeta")).toHaveAttribute(
      "href",
      "/admin/tenants/77777777-7777-4777-8777-777777777777",
    );
  });

  it("tenant ativo mantém Suspender (e a lista continua com os outros dois)", () => {
    montar(linha({}));

    expect(screen.getByLabelText(/^Suspender/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Reativar/)).toBeNull();
    expect(screen.getByLabelText(/Acompanhar/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Editar/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// (c) redacted: NENHUM dos três
// ---------------------------------------------------------------------------

describe("tenant redigido", () => {
  it("não oferece nenhum dos três atalhos", () => {
    montar(
      linha({
        id: "44444444-4444-4444-8444-444444444444",
        display_name: "Apagada",
        status: "redacted",
        onboarded_at: null,
      }),
    );

    expect(screen.queryByLabelText(/Acompanhar/)).toBeNull();
    expect(screen.queryByLabelText(/Editar/)).toBeNull();
    expect(screen.queryByLabelText(/Suspender/)).toBeNull();
    expect(screen.queryByLabelText(/Reativar/)).toBeNull();
  });

  it("continua alcançável: a linha mantém o link para a ficha", () => {
    montar(
      linha({
        id: "44444444-4444-4444-8444-444444444444",
        display_name: "Apagada",
        status: "redacted",
        onboarded_at: null,
      }),
    );

    expect(screen.getByRole("link", { name: "Ver" })).toHaveAttribute(
      "href",
      "/admin/tenants/44444444-4444-4444-8444-444444444444",
    );
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (d) Suspender é AÇÃO na própria lista: diálogo com o display_name, sem
//     navegação, e cancelar não dispara a mutation
// ---------------------------------------------------------------------------

describe("suspender sem sair da listagem", () => {
  it("abre o diálogo com o display_name e cancelar não dispara a mutation", async () => {
    const user = userEvent.setup();
    const urlAntes = window.location.href;
    montar(linha({ id: "55555555-5555-4555-8555-555555555555", display_name: "Delta" }));

    await user.click(screen.getByLabelText("Suspender Delta"));

    const dialogo = await screen.findByRole("alertdialog");
    // O nome do tenant TEM de estar no diálogo: suspender sem saber quem é o alvo
    // é como se derruba a instalação errada.
    expect(within(dialogo).getByText("Delta")).toBeInTheDocument();

    await user.click(within(dialogo).getByRole("button", { name: "Cancelar" }));

    expect(suspender).not.toHaveBeenCalled();
    // Não navega: a posição na lista é preservada.
    expect(window.location.href).toBe(urlAntes);
    expect(screen.getByText("Delta")).toBeInTheDocument();
  });

  it("confirmar com motivo válido dispara a mutation certa — ação, não navegação", async () => {
    const user = userEvent.setup();
    montar(linha({ id: "66666666-6666-4666-8666-666666666666", display_name: "Épsilon" }));

    await user.click(screen.getByLabelText("Suspender Épsilon"));
    const dialogo = await screen.findByRole("alertdialog");

    await user.type(
      within(dialogo).getByRole("textbox"),
      "CNPJ duplicado na base, revisão manual.",
    );
    await user.click(within(dialogo).getByRole("button", { name: /Confirmar suspensão/ }));

    expect(suspender).toHaveBeenCalledTimes(1);
    expect(suspender).toHaveBeenCalledWith(
      { id: "66666666-6666-4666-8666-666666666666", reason: "CNPJ duplicado na base, revisão manual." },
      expect.anything(),
    );
  });
});
