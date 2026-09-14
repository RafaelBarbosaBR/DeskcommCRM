/**
 * O algoritmo do tracker.js que precisa estar certo mesmo sem poder rodar o
 * script no browser aqui: `_fbc` pela spec da Meta, detecção de link de
 * WhatsApp (item 3 — nunca lê conversa, só detecta o clique) e extração de
 * UTM/click-id sem nunca inventar o que não veio na URL (item 1).
 */
import { describe, expect, it } from "vitest";

import {
  calcularFbc,
  ehLinkDeWhatsApp,
  extrairParametrosDeRastreio,
} from "@/lib/rastreamento/captura/logica";

describe("_fbc segue a spec oficial da Meta", () => {
  it("monta fb.1.<timestamp_ms>.<fbclid>", () => {
    expect(calcularFbc("ABC123", 1_700_000_000_000)).toBe("fb.1.1700000000000.ABC123");
  });
});

describe("detecção de link de WhatsApp — nunca lê conversa, só clique", () => {
  it.each([
    "https://wa.me/5511988887777",
    "http://wa.me/5511988887777?text=oi",
    "//wa.me/5511988887777",
    "https://api.whatsapp.com/send?phone=5511988887777",
    "https://web.whatsapp.com/send?phone=5511988887777",
    "whatsapp://send?phone=5511988887777",
  ])("reconhece %s como link de WhatsApp", (href) => {
    expect(ehLinkDeWhatsApp(href)).toBe(true);
  });

  it.each([
    "https://example.com/wa.me-not-really",
    "https://example.com/contact",
    "mailto:oi@example.com",
    "https://notwhatsapp.com/",
  ])("não confunde %s com link de WhatsApp", (href) => {
    expect(ehLinkDeWhatsApp(href)).toBe(false);
  });
});

describe("extração de UTM/click-id nunca inventa o que não existe", () => {
  it("lê só os parâmetros que estão na URL", () => {
    const params = extrairParametrosDeRastreio(
      "https://site.com/?utm_source=meta&utm_campaign=promo&fbclid=CLICK123",
    );
    expect(params.utm_source).toBe("meta");
    expect(params.utm_campaign).toBe("promo");
    expect(params.fbclid).toBe("CLICK123");
    // Nunca fabricado: ausente na URL vira null, não string vazia nem undefined.
    expect(params.gclid).toBeNull();
    expect(params.utm_medium).toBeNull();
  });

  it("URL sem nenhum parâmetro de rastreio devolve tudo null", () => {
    const params = extrairParametrosDeRastreio("https://site.com/pagina");
    expect(Object.values(params).every((v) => v === null)).toBe(true);
  });

  it("URL inválida não derruba a extração — devolve tudo null", () => {
    const params = extrairParametrosDeRastreio("não é uma url");
    expect(Object.values(params).every((v) => v === null)).toBe(true);
  });
});
