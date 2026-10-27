import fs from "node:fs";
import path from "node:path";

import { razaoDeContraste } from "@/lib/branding/contraste";

/**
 * Contraste CALCULADO de um utilitário de cor do Tailwind contra um token de
 * superfície, nos dois temas, a partir do próprio `app/globals.css`.
 *
 * O jsdom não aplica o Tailwind, então `getComputedStyle` no teste de
 * componente devolve vazio. O que dá para medir aqui é a cadeia de tokens que
 * a classe nomeia: `border-muted-foreground` → `--color-muted-foreground` (no
 * `@theme inline`) → `--color-text-muted` → o hex de cada tema.
 */
const CSS = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");

function bloco(seletor: string): string {
  const rx = new RegExp(`^${seletor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`, "m");
  const i = CSS.search(rx);
  if (i < 0) throw new Error(`não achei o bloco \`${seletor}\` em globals.css`);
  return CSS.slice(i, CSS.indexOf("\n}", i));
}

function valor(texto: string, prop: string): string | undefined {
  const m = texto.match(new RegExp(`^\\s*${prop}:\\s*([^;]+);`, "m"));
  return m?.[1]?.trim();
}

const PONTE = bloco("@theme inline");
const TEMA = { claro: bloco(":root"), escuro: bloco('[data-theme="dark"]') } as const;
export type Tema = keyof typeof TEMA;

function hexDoToken(nome: string, tema: Tema): string {
  let v = valor(PONTE, `--color-${nome}`);
  if (!v) throw new Error(`\`--color-${nome}\` não tem ponte no @theme inline`);
  for (let i = 0; i < 5 && v.startsWith("var("); i++) {
    const prop = v.slice(4, -1).trim();
    v = valor(TEMA[tema], prop) ?? valor(TEMA.claro, prop) ?? v;
  }
  if (!/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`\`${nome}\` no tema ${tema} resolveu para \`${v}\``);
  return v;
}

/** O nome do token de cor que a classe usa com o prefixo (`border`, `text`…). */
export function tokenDaClasse(className: string, prefixo: string): string {
  const nomes = [...className.matchAll(new RegExp(`(?:^|\\s)${prefixo}-([a-z-]+)(?=\\s|$)`, "g"))]
    .map((m) => m[1] ?? "")
    .filter((n) => valor(PONTE, `--color-${n}`) !== undefined);
  if (nomes.length !== 1) throw new Error(`esperava 1 cor \`${prefixo}-*\` em "${className}", achei ${nomes.length}`);
  return nomes[0] as string;
}

export function contrasteNoTema(frente: string, fundo: string, tema: Tema): number {
  return razaoDeContraste(hexDoToken(frente, tema), hexDoToken(fundo, tema));
}
