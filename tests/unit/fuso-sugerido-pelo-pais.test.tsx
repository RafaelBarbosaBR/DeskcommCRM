/**
 * ESCOLHER PORTUGAL SUGERE O FUSO DE PORTUGAL, E ESCOLHER O BRASIL NÃO SUGERE
 * LISBOA (issue #2347, item 4).
 *
 * Uma organização de Portugal que nunca trocou o fuso ficava com o
 * `America/Sao_Paulo` do padrão e mandava ao titular datas em GMT-3: o documento
 * de acesso saía com a hora de São Paulo. O seletor de país passa a oferecer o
 * fuso do país escolhido, e quem quiser outro fuso ainda pode recusar — a
 * sugestão entra no campo "Fuso horário", que continua sendo um seletor comum.
 *
 * A sugestão NÃO é "Lisboa" escrita na tela: é o fuso do país (`fusoDoSugerido`
 * do perfil), e por isso o Brasil continua sugerindo São Paulo.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { TenantForm } from "@/app/app/settings/tenant/_form";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { TenantInput } from "@/lib/schemas/settings";

vi.mock("@/app/actions/settings/updateTenant", () => ({
  updateTenant: vi.fn(async () => ({ ok: true })),
}));

/** O `country: null` da coluna é o Brasil, e o fuso nasce no padrão do produto. */
const BASE: TenantInput = {
  display_name: "Empresa",
  legal_name: "Empresa Lda",
  cnpj: null,
  timezone: "America/Sao_Paulo",
  locale: "pt-BR",
  currency: "BRL",
  media_retention_days: 365,
  media_retention_enforced: true,
  dpo_email: null,
  privacy_policy_url: null,
};

beforeAll(() => {
  // jsdom não implementa captura de ponteiro — mesmo remédio dos outros testes
  // que abrem um Select do Radix.
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});
afterEach(cleanup);

function tela(country: string | null) {
  render(
    <IdiomaProvider locale="pt-BR">
      <TenantForm initial={{ ...BASE, country }} />
    </IdiomaProvider>,
  );
}

/** Escolhe um país no seletor e devolve o que o campo de fuso passou a mostrar. */
async function escolherPais(nome: string) {
  const user = userEvent.setup();
  await user.click(screen.getByLabelText("País"));
  await user.click(await screen.findByRole("option", { name: nome }));
  return screen.getByLabelText("Fuso horário").textContent ?? "";
}

describe("o seletor de país sugere o fuso do país escolhido", () => {
  it("Portugal sugere Europe/Lisbon", async () => {
    tela(null);

    expect(await escolherPais("Portugal")).toContain("Europe/Lisbon");
  });

  it("Brasil sugere São Paulo, e Lisboa não aparece", async () => {
    tela("PT");

    const mostrado = await escolherPais("Brasil");
    expect(mostrado).toContain("America/Sao_Paulo");
    expect(mostrado).not.toContain("Europe/Lisbon");
  });

  it("a sugestão pode ser recusada: trocar o fuso depois do país vale", async () => {
    tela(null);
    await escolherPais("Portugal");

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Fuso horário"));
    await user.click(await screen.findByRole("option", { name: "Europe/Madrid" }));

    const mostrado = screen.getByLabelText("Fuso horário").textContent ?? "";
    expect(mostrado).toContain("Europe/Madrid");
    expect(mostrado).not.toContain("Europe/Lisbon");
  });
});
