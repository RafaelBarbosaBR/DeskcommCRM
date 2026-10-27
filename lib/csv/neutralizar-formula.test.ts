import { describe, expect, it } from "vitest";

import { neutralizarFormula } from "./neutralizar-formula";

describe("neutralizarFormula", () => {
  it("começo de célula com =, +, -, @, TAB ou CR ganha a aspa", () => {
    for (const c of ["=1+1", "+cmd", "-cmd", "@x", "\tx", "\rx"]) expect(neutralizarFormula(c)).toBe(`'${c}`);
  });

  it("todo trecho depois de ;, vírgula, LF ou CR também ganha", () => {
    expect(neutralizarFormula("a;=1+1")).toBe("a;'=1+1");
    expect(neutralizarFormula("a,@x")).toBe("a,'@x");
    expect(neutralizarFormula("a\n=1+1")).toBe("a\n'=1+1");
    expect(neutralizarFormula("a\r-2+3+cmd")).toBe("a\r'-2+3+cmd");
  });

  it("número puro passa intacto: telefone E.164 e negativo dentro de JSON", () => {
    expect(neutralizarFormula("+5511999998888")).toBe("+5511999998888");
    expect(neutralizarFormula('{"v":[1,-2.5e3]}')).toBe('{"v":[1,-2.5e3]}');
  });

  it("texto comum não muda", () => {
    expect(neutralizarFormula("Loja Comum, Ltda; filial")).toBe("Loja Comum, Ltda; filial");
  });
});
