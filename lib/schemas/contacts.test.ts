import { describe, expect, it } from "vitest";
import { contactPatchSchema } from "./contacts";

describe("tags do contato — validação de servidor (item 1 do pedido)", () => {
  it("trim + minúsculo + corta em 50 caracteres, mesmo vindo de fora do input HTML", () => {
    const bruto = "A".repeat(60);
    const parsed = contactPatchSchema.parse({ tags: ["  VIP  ", bruto] });
    expect(parsed.tags).toEqual(["vip", "a".repeat(50)]);
  });

  it("remove duplicadas depois de normalizar", () => {
    const parsed = contactPatchSchema.parse({ tags: ["Vip", "vip", " VIP"] });
    expect(parsed.tags).toEqual(["vip"]);
  });

  it("tag vazia (só espaço) não sobrevive à normalização", () => {
    const parsed = contactPatchSchema.parse({ tags: ["   ", "recompra"] });
    expect(parsed.tags).toEqual(["recompra"]);
  });
});

describe("links de redes sociais — limites do item 2 do pedido", () => {
  it("recusa site/instagram/facebook acima de 500 caracteres", () => {
    const longo = "a".repeat(501);
    expect(() => contactPatchSchema.parse({ website_url: longo })).toThrow();
    expect(() => contactPatchSchema.parse({ instagram_url: longo })).toThrow();
    expect(() => contactPatchSchema.parse({ facebook_url: longo })).toThrow();
  });

  it("aceita Google Maps até 1000 caracteres (URL de local é mais longa)", () => {
    const noLimite = "a".repeat(1000);
    expect(() => contactPatchSchema.parse({ google_maps_url: noLimite })).not.toThrow();
    expect(() => contactPatchSchema.parse({ google_maps_url: "a".repeat(1001) })).toThrow();
  });
});

describe("telefone digitado — limite do item 3 do pedido", () => {
  it("phone_raw aceita até 30 caracteres", () => {
    expect(() => contactPatchSchema.parse({ phone_raw: "a".repeat(30) })).not.toThrow();
    expect(() => contactPatchSchema.parse({ phone_raw: "a".repeat(31) })).toThrow();
  });
});
