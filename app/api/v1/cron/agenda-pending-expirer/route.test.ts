/**
 * O PEDIDO PENDENTE EXPIRA PELO PRAZO DO TIPO, NÃO POR UM NÚMERO FIXO.
 *
 * Mesmo desenho de `contact-birthdays/route.test.ts`:
 *
 * - `estaVencido` é pura, exercitada com instantes e prazos de verdade.
 *
 * - "reusa `cancelarAgendamentoHandler`, não faz UPDATE cru" é ESTRUTURAL — a
 *   garantia vive em COMO o cancelamento é disparado, não numa função
 *   isolada. Montar um dublê de Supabase pra provar isso testaria o dublê —
 *   o que prende é ler a fonte e cobrar a chamada e o escopo por organização.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { estaVencido } from "./route";

describe("estaVencido — o prazo é o do TIPO, contado a partir da criação", () => {
  it("⭐ um pedido criado há exatamente o prazo está vencido (limite inclusivo)", () => {
    const criadoEm = new Date("2026-09-15T10:00:00.000Z");
    const agora = new Date("2026-09-16T10:00:00.000Z"); // +24h exatas
    expect(estaVencido(agora, criadoEm, 24)).toBe(true);
  });

  it("um minuto antes do prazo NÃO está vencido", () => {
    const criadoEm = new Date("2026-09-15T10:00:00.000Z");
    const agora = new Date("2026-09-16T09:59:00.000Z");
    expect(estaVencido(agora, criadoEm, 24)).toBe(false);
  });

  it("⭐ prazos diferentes por tipo — 1h vence rápido, 720h (30 dias) demora", () => {
    const criadoEm = new Date("2026-09-15T10:00:00.000Z");
    const umaHoraDepois = new Date("2026-09-15T11:00:00.000Z");
    expect(estaVencido(umaHoraDepois, criadoEm, 1)).toBe(true);
    expect(estaVencido(umaHoraDepois, criadoEm, 720)).toBe(false);
  });
});

describe("a fonte — garantias estruturais que um dublê de Supabase testaria a si mesmo", () => {
  const fonte = readFileSync(join(__dirname, "route.ts"), "utf8");

  it("⭐ reusa cancelarAgendamentoHandler — não escreve UPDATE cru em calendar_appointments", () => {
    expect(fonte).toContain("cancelarAgendamentoHandler(");
    expect(fonte).not.toMatch(/\.from\(\s*"calendar_appointments"\s*\)\s*\.update\(/);
  });

  it("⭐ a consulta filtra status='pending' — não toca compromisso confirmado nem já resolvido", () => {
    const consulta = fonte.slice(
      fonte.indexOf('.from("calendar_appointments")'),
      fonte.indexOf(".limit("),
    );
    expect(consulta).toMatch(/\.eq\(\s*"status",\s*"pending"\s*\)/);
  });

  it("o cancelamento é escopado pela organização DA LINHA lida, nunca por parâmetro externo", () => {
    const chamada = fonte.slice(
      fonte.indexOf("cancelarAgendamentoHandler("),
      fonte.indexOf("cancelarAgendamentoHandler(") + 400,
    );
    expect(chamada).toContain("organization_id: linha.organization_id");
  });

  it("⭐ o corte fino usa estaVencido com o prazo do TIPO da linha, não um número fixo", () => {
    const posVencido = fonte.indexOf("estaVencido(agora, new Date(linha.created_at)");
    expect(posVencido, "a checagem fina não existe na fonte").toBeGreaterThan(-1);
    expect(fonte.slice(posVencido, posVencido + 80)).toContain("tipo.pending_expiration_hours");
  });

  it("não audita direto — depende do audit interno de cancelarAgendamentoHandler", () => {
    expect(fonte).not.toMatch(/\baudit\(/);
  });
});
