import { describe, expect, it } from "vitest";

import { calcularAjusteProporcional } from "./prorata";

const data = (s: string) => new Date(s);

describe("calcularAjusteProporcional", () => {
  it("cobra a diferença pelo saldo de metade do período pago", () => {
    expect(calcularAjusteProporcional({
      precoAtualCents: 9_669,
      precoNovoCents: 29_669,
      periodoPagoDesde: data("2026-10-01T00:00:00Z"),
      proximoVencimento: data("2026-11-01T00:00:00Z"),
      agora: data("2026-10-16T12:00:00Z"),
    })).toBe(10_000);
  });

  it("não cobra no downgrade ou quando o período pago terminou", () => {
    const base = {
      periodoPagoDesde: data("2026-10-01T00:00:00Z"),
      proximoVencimento: data("2026-11-01T00:00:00Z"),
      agora: data("2026-11-02T00:00:00Z"),
    };
    expect(calcularAjusteProporcional({ ...base, precoAtualCents: 29_669, precoNovoCents: 9_669 })).toBe(0);
    expect(calcularAjusteProporcional({ ...base, precoAtualCents: 9_669, precoNovoCents: 29_669 })).toBe(0);
  });

  it("não inventa valor quando o provedor ainda não informou o período pago", () => {
    expect(calcularAjusteProporcional({
      precoAtualCents: 9_669,
      precoNovoCents: 29_669,
      periodoPagoDesde: null,
      proximoVencimento: data("2026-11-01T00:00:00Z"),
      agora: data("2026-10-16T00:00:00Z"),
    })).toBeNull();
  });
});

describe("calcularAjusteProporcional — mínimo do provedor", () => {
  const base = { periodoPagoDesde: data("2026-10-01T00:00:00Z"), proximoVencimento: data("2026-11-01T00:00:00Z") };
  it("ajuste abaixo de R$ 5,00 vira 0: o upgrade é agendado em vez de ir ao provedor e voltar recusado", () => {
    // Faltando 6 h para o fim, R$ 50,00 de diferença dá ~R$ 0,40.
    expect(calcularAjusteProporcional({ ...base, precoAtualCents: 4_990, precoNovoCents: 9_990, agora: data("2026-10-31T18:00:00Z") })).toBe(0);
  });
  it("controle: R$ 5,00 em diante é cobrado", () => {
    expect(calcularAjusteProporcional({ ...base, precoAtualCents: 0, precoNovoCents: 1_000, agora: data("2026-10-16T12:00:00Z") })).toBe(500);
  });
});
