import { describe, expect, it } from "vitest";
import { gerarLinkWhatsApp } from "./whatsapp-link";

describe("gerarLinkWhatsApp", () => {
  it("11 dígitos (DDD + celular BR) ganham o código de país configurado", () => {
    expect(gerarLinkWhatsApp("(11) 98888-7777", "55")).toBe("https://wa.me/5511988887777");
  });

  it("10 dígitos (DDD + fixo) também ganham o código configurado", () => {
    expect(gerarLinkWhatsApp("11 3888-7777", "55")).toBe("https://wa.me/551138887777");
  });

  it("já com código de país (13 dígitos) não duplica o prefixo", () => {
    expect(gerarLinkWhatsApp("+55 11 98888-7777", "55")).toBe("https://wa.me/5511988887777");
  });

  it("heurística de país nunca é fixa — muda com o parâmetro", () => {
    expect(gerarLinkWhatsApp("11987654321", "1")).toBe("https://wa.me/111987654321");
  });

  it("sem nenhum dígito devolve null (botão não aparece)", () => {
    expect(gerarLinkWhatsApp("abc", "55")).toBeNull();
    expect(gerarLinkWhatsApp("", "55")).toBeNull();
    expect(gerarLinkWhatsApp(null, "55")).toBeNull();
  });
});
