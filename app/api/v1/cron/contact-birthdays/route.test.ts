/**
 * O ANIVERSÁRIO SÓ AVISA NO FUSO DE QUEM RECEBE, E SÓ UMA VEZ POR ANO.
 *
 * As duas regras são testadas de formas diferentes de propósito — mesmo
 * desenho de `agenda-reminder/route.test.ts`:
 *
 * - `estaNaJanelaDoAviso` é pura, então o teste a exercita com FUSOS DE
 *   VERDADE (não mock de fuso): o mesmo instante UTC precisa dizer "sim" pra
 *   uma organização e "não" pra outra, conforme o fuso de cada uma.
 *
 * - "não emite 2× pro mesmo contato" é ESTRUTURAL: a garantia vive no
 *   ENCADEAMENTO da consulta a `event_log` ANTES do `emit_event`, não numa
 *   função isolada. Montar um dublê de Supabase pra provar isso testaria o
 *   dublê — o que prende é ler a fonte e cobrar a ordem, o mesmo estilo do
 *   isolamento entre organizações em `agenda-reminder`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { estaNaJanelaDoAviso, HORA_LOCAL_DO_AVISO } from "./route";

describe("estaNaJanelaDoAviso — 9h é local, não global", () => {
  it("⭐ o MESMO instante UTC é 9h em São Paulo e NÃO é em Tóquio", () => {
    // 2026-09-15T12:00:00Z: em América/São_Paulo (UTC-3) são 09:00; em
    // Asia/Tokyo (UTC+9) já são 21:00 do mesmo dia.
    const agora = new Date("2026-09-15T12:00:00.000Z");
    expect(estaNaJanelaDoAviso(agora, "America/Sao_Paulo")).toBe(true);
    expect(estaNaJanelaDoAviso(agora, "Asia/Tokyo")).toBe(false);
  });

  it("⭐ uma hora depois, o padrão se inverte — Tóquio (UTC+9) bate 9h primeiro", () => {
    // 2026-09-15T00:00:00Z: em Asia/Tokyo são 09:00; em América/São_Paulo
    // ainda são 21:00 do dia ANTERIOR.
    const agora = new Date("2026-09-15T00:00:00.000Z");
    expect(estaNaJanelaDoAviso(agora, "Asia/Tokyo")).toBe(true);
    expect(estaNaJanelaDoAviso(agora, "America/Sao_Paulo")).toBe(false);
  });

  it("qualquer outra hora local (8h, 10h) NÃO está na janela", () => {
    const oitoHoras = new Date("2026-09-15T11:00:00.000Z"); // 08:00 em SP
    const dezHoras = new Date("2026-09-15T13:00:00.000Z"); // 10:00 em SP
    expect(estaNaJanelaDoAviso(oitoHoras, "America/Sao_Paulo")).toBe(false);
    expect(estaNaJanelaDoAviso(dezHoras, "America/Sao_Paulo")).toBe(false);
  });

  it("a constante exportada é 9 — documentando o contrato que o teste prende", () => {
    expect(HORA_LOCAL_DO_AVISO).toBe(9);
  });
});

describe("a fonte — garantias estruturais que um dublê de Supabase testaria a si mesmo", () => {
  const fonte = readFileSync(join(__dirname, "route.ts"), "utf8");

  it("⭐ o dedupe por event_log vem ANTES do emit_event — sem isso, reenviaria todo ano igual", () => {
    const posDedupe = fonte.indexOf("jaEmitidos.has(contactId)");
    const posEmit = fonte.indexOf('p_event_type: "contact.birthday"');
    expect(posDedupe, "a checagem de já-emitido não existe na fonte").toBeGreaterThan(-1);
    expect(posEmit, "a chamada de emit_event não existe na fonte").toBeGreaterThan(-1);
    expect(posDedupe).toBeLessThan(posEmit);
  });

  it("⭐ organization_id SEMPRE filtra a leitura de event_log — sem isso, o ano de uma organização silenciaria o aviso de outra", () => {
    const bloco = fonte.slice(
      fonte.indexOf('.from("event_log")'),
      fonte.indexOf("jaEmitidos = new Set"),
    );
    expect(bloco).toMatch(/\.eq\(\s*"organization_id",\s*org\.id\s*\)/);
    expect(bloco).toMatch(/\.eq\(\s*"event_type",\s*"contact\.birthday"\s*\)/);
  });

  it("a busca de aniversariantes é escopada pela organização do laço, não por parâmetro externo", () => {
    const chamada = fonte.slice(
      fonte.indexOf('.rpc("fn_aniversariantes_do_dia"'),
      fonte.indexOf('.rpc("fn_aniversariantes_do_dia"') + 200,
    );
    expect(chamada).toContain("p_org: org.id");
  });

  it("o corte de ano usa o ANO LOCAL da organização, não getFullYear() do processo", () => {
    // `new Date().getFullYear()` leria o fuso da MÁQUINA que roda o cron —
    // numa VPS em UTC isso pode ser um dia (ou um ano, na virada) diferente
    // do que a organização vive. `parede.ano` vem de `partesNoFuso`, no
    // fuso DA ORGANIZAÇÃO.
    expect(fonte).not.toMatch(/getFullYear\(\)/);
    expect(fonte).toContain("parede.ano");
  });

  it("emit_event carrega organization_id explícito — nunca deixa o service role inferir a org", () => {
    const chamada = fonte.slice(
      fonte.indexOf('p_event_type: "contact.birthday"') - 50,
      fonte.indexOf('p_event_type: "contact.birthday"') + 300,
    );
    expect(chamada).toContain("p_organization_id: org.id");
    expect(chamada).toContain('p_entity_kind: "contact"');
  });
});
