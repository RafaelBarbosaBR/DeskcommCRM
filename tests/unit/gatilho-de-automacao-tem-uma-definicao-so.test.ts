/**
 * O VOCABULÁRIO DE GATILHOS DE AUTOMAÇÃO TEM TRÊS CÓPIAS, E ELAS PODEM
 * DIVERGIR SEM NINGUÉM PERCEBER.
 *
 *   `lib/schemas/webhooks.ts`             TRIGGER_EVENTS      — o que o zod aceita ao salvar a regra
 *   `lib/automation/engine.ts`            EXPECTED_ENTITY_KIND — o que o motor sabe RODAR
 *   `app/app/webhooks/_components/labels.ts` TRIGGER_LABELS   — o que a tela OFERECE
 *
 * Um evento em `TRIGGER_EVENTS` sem entrada em `EXPECTED_ENTITY_KIND` passa no
 * `z.enum`, a regra salva, e o motor nunca casa (`expectedKind` vem
 * `undefined`, o guard de entity_kind não filtra nada — silêncio, não erro).
 * Um evento em `TRIGGER_EVENTS` sem `TRIGGER_LABELS` quebra a tela em runtime
 * (`t(undefined)`) só quando alguém abre o seletor. E o inverso — um evento
 * que o motor reconhece mas o zod recusa — trava a regra na criação, sem
 * pista de qual dos três arquivos ficou para trás.
 *
 * Este arquivo lê os TRÊS de onde vivem (fonte, não import de constante
 * privada — `EXPECTED_ENTITY_KIND` não é exportada, e não deveria virar
 * pública só para um teste ler) e exige o MESMO conjunto de chaves nos três.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TRIGGER_EVENTS } from "@/lib/schemas/webhooks";
import { TRIGGER_LABELS } from "@/app/app/webhooks/_components/labels";

const RAIZ = join(__dirname, "..", "..");

/** As chaves de `EXPECTED_ENTITY_KIND`, lidas da FONTE — a constante é privada de propósito. */
function chavesDoMotor(): string[] {
  const fonte = readFileSync(join(RAIZ, "lib/automation/engine.ts"), "utf8");
  const inicio = fonte.indexOf("const EXPECTED_ENTITY_KIND");
  const fim = fonte.indexOf("};", inicio);
  const bloco = fonte.slice(inicio, fim);
  return [...bloco.matchAll(/"([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)":/g)].map((m) => m[1]!);
}

describe("o vocabulário de gatilhos de automação é o MESMO nos três arquivos", () => {
  it("controle: a leitura da fonte enxerga os 5 gatilhos originais + os 4 novos da agenda", () => {
    // Falha aqui, e não nos casos abaixo, é a sonda cega — não o vocabulário
    // divergente.
    const chaves = chavesDoMotor();
    expect(chaves.length).toBeGreaterThanOrEqual(9);
    expect(chaves).toContain("lead.created");
    expect(chaves).toContain("agenda.appointment_confirmed");
  });

  it("⭐ TRIGGER_EVENTS (zod) === chaves de EXPECTED_ENTITY_KIND (motor)", () => {
    const doMotor = chavesDoMotor().sort();
    const doZod = [...TRIGGER_EVENTS].sort();
    expect(
      doZod,
      "um evento existe num lado e não no outro — a regra salva e o motor não roda, ou o motor reconhece um evento que ninguém consegue configurar",
    ).toEqual(doMotor);
  });

  it("⭐ todo TRIGGER_EVENTS tem rótulo em TRIGGER_LABELS", () => {
    const semRotulo = TRIGGER_EVENTS.filter((ev) => !(ev in TRIGGER_LABELS));
    expect(
      semRotulo,
      "evento sem rótulo: o seletor da tela quebra em runtime (t(undefined)) só quando alguém tenta escolhê-lo",
    ).toEqual([]);
  });

  it("TRIGGER_LABELS não tem rótulo ÓRFÃO (sem evento correspondente em TRIGGER_EVENTS)", () => {
    // O tipo `Record<TriggerEvent, string>` já impede isso em compile-time —
    // este caso é o controle de que o tipo está fazendo o trabalho, não um
    // `as` escondido furando a checagem.
    const chaves = Object.keys(TRIGGER_LABELS);
    expect(chaves.sort()).toEqual([...TRIGGER_EVENTS].sort());
  });

  it("os 4 gatilhos novos da agenda (Onda 4.1) são ancorados em crm_lead", () => {
    const fonte = readFileSync(join(RAIZ, "lib/automation/engine.ts"), "utf8");
    const inicio = fonte.indexOf("const EXPECTED_ENTITY_KIND");
    const fim = fonte.indexOf("};", inicio);
    const bloco = fonte.slice(inicio, fim);
    for (const ev of [
      "agenda.appointment_scheduled",
      "agenda.appointment_confirmed",
      "agenda.appointment_rescheduled",
      "agenda.appointment_cancelled",
    ]) {
      expect(bloco).toMatch(new RegExp(`"${ev}":\\s*"crm_lead"`));
    }
  });
});
