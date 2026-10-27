/**
 * A RECUPERAÇÃO DE SENHA FALA O IDIOMA DO VISITANTE — INCLUSIVE O RÓTULO DO E-MAIL.
 *
 * O #3100 fez a casca das telas de acesso seguir o idioma do navegador, mas o rótulo « Email » do formulário de
 * recuperação estava escrito cru, fora de t(): em espanhol a tela dizia « Email » no meio de um formulário em espanhol
 * (medido pela tela na prova do #3100). Em português, byte a byte como antes.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/auth/requestPasswordReset", () => ({ requestPasswordReset: vi.fn() }));

import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";
import { traduzir } from "@/lib/i18n/dicionario";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

afterEach(cleanup);

describe("recuperação de senha", () => {
  it("em espanhol: o rótulo do e-mail traduzido", () => {
    render(<IdiomaProvider locale="es"><ForgotPasswordForm /></IdiomaProvider>);
    expect(traduzir("Email", "es")).not.toBe("Email");
    expect(screen.getByLabelText(traduzir("Email", "es"))).toBeTruthy();
  });

  it("em português, como antes: « Email »", () => {
    render(<IdiomaProvider locale="pt-BR"><ForgotPasswordForm /></IdiomaProvider>);
    expect(screen.getByLabelText("Email")).toBeTruthy();
  });
});
