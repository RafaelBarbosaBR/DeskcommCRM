import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chamadaDeVozLigada, estadoDaVoz, instalacaoOfereceVoz } from "./opt-in";

describe("lib/voice/opt-in", () => {
  const original = process.env.WACALLS_API_BASE_URL;

  beforeEach(() => {
    delete process.env.WACALLS_API_BASE_URL;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.WACALLS_API_BASE_URL;
    else process.env.WACALLS_API_BASE_URL = original;
  });

  it("instalacaoOfereceVoz é false sem env nenhuma", () => {
    expect(instalacaoOfereceVoz()).toBe(false);
  });

  it("instalacaoOfereceVoz é true com a URL presente", () => {
    process.env.WACALLS_API_BASE_URL = "http://wacalls:8080";
    expect(instalacaoOfereceVoz()).toBe(true);
  });

  it("estadoDaVoz: instalação não oferece vence, mesmo com organização aceitando", () => {
    expect(estadoDaVoz(false, true)).toBe("instalacao_nao_oferece");
  });

  it("estadoDaVoz: instalação oferece mas organização não aceitou", () => {
    expect(estadoDaVoz(true, false)).toBe("organizacao_nao_aceitou");
  });

  it("estadoDaVoz: ligado só quando os dois eixos concordam", () => {
    expect(estadoDaVoz(true, true)).toBe("ligado");
  });

  it("chamadaDeVozLigada é false quando a instalação não oferece, mesmo com organização = true", () => {
    expect(chamadaDeVozLigada(true)).toBe(false);
  });

  it("chamadaDeVozLigada é true só com os dois eixos", () => {
    process.env.WACALLS_API_BASE_URL = "http://wacalls:8080";
    expect(chamadaDeVozLigada(false)).toBe(false);
    expect(chamadaDeVozLigada(true)).toBe(true);
  });
});
