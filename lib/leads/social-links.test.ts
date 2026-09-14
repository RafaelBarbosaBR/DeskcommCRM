import { describe, expect, it } from "vitest";
import { normalizarLink } from "./social-links";

describe("normalizarLink — garante protocolo antes de virar link clicável", () => {
  it("prefixa https:// quando falta protocolo", () => {
    const r = normalizarLink("www.empresa.com.br");
    expect(r?.href).toBe("https://www.empresa.com.br");
  });

  it("não mexe em quem já veio com protocolo", () => {
    const r = normalizarLink("http://empresa.com.br/pagina");
    expect(r?.href).toBe("http://empresa.com.br/pagina");
  });

  it("normalizado nunca tem protocolo, www. nem barra final — e não é usável como href", () => {
    const r = normalizarLink("HTTPS://WWW.Empresa.com.br/");
    expect(r?.normalizado).toBe("empresa.com.br");
  });

  it("string vazia ou só espaço devolve null", () => {
    expect(normalizarLink("")).toBeNull();
    expect(normalizarLink("   ")).toBeNull();
  });
});
