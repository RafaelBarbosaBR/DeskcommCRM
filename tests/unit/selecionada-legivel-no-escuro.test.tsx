/**
 * A conversa selecionada na lista do Inbox é legível no tema escuro.
 *
 * Os degraus `accent-50…950` têm o MESMO hex nos dois temas (`app/globals.css`):
 * são a rampa da marca, não tokens de superfície. A linha selecionada usava
 * `bg-accent-50` — quase branco — e o nome do contato é `text-text`, que no
 * escuro é claro: branco sobre branco. `accent-soft` é o token que o tema troca
 * (uma camada translúcida no escuro), e é o que as outras seleções da tela já usam.
 *
 * A medida do contraste de verdade (cor computada contra o fundo efetivo) está
 * na spec `tests/e2e/inbox-selecionada-no-escuro.spec.ts`; aqui fica a regra
 * que a impede de voltar sem precisar de navegador.
 */
import fs from "node:fs";
import path from "node:path";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConversationListItem } from "@/components/inbox/ConversationListItem";
import { conversaDeExemplo } from "@/components/inbox/__fixtures__/conversa";

// ── Contraste WCAG calculado a partir dos tokens de `app/globals.css` ─────────
// O jsdom não aplica o Tailwind; o que dá para medir sem navegador é o par de
// TOKENS que a linha usa, com os valores que o tema declara. A spec e2e mede a
// tela; esta régua mede a escolha de token e roda em todo `test:unit`.
const CSS = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");

function bloco(seletor: string): string {
  const i = CSS.search(new RegExp(`^${seletor.replace(/[[\]"=]/g, "\\$&")}\\s*\\{`, "m"));
  if (i < 0) throw new Error(`bloco ${seletor} não achado`);
  return CSS.slice(i, CSS.indexOf("\n}", i));
}

function token(tema: "light" | "dark", nome: string): string {
  const blocos = tema === "dark" ? [bloco('[data-theme="dark"]'), bloco(":root")] : [bloco(":root")];
  for (const b of blocos) {
    const m = b.match(new RegExp(`^\\s*${nome}:\\s*([^;]+);`, "m"));
    if (!m?.[1]) continue;
    const v = m[1].trim();
    const ref = v.match(/^var\((--[a-z0-9-]+)\)$/);
    return ref?.[1] ? token(tema, ref[1]) : v;
  }
  throw new Error(`token ${nome} não achado no tema ${tema}`);
}

type Rgba = [number, number, number, number];
function cor(v: string): Rgba {
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex?.[1]) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)).concat(1) as Rgba;
  const rgba = v.match(/^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4])];
  throw new Error(`cor não suportada: ${v}`);
}

/** `camada` pintada `vezes` sobre `base` (alpha composto, como o navegador faz). */
function sobre(camada: Rgba, base: Rgba, vezes = 1): Rgba {
  let r = base;
  for (let n = 0; n < vezes; n++) r = [0, 1, 2].map((i) => camada[i]! * camada[3] + r[i]! * (1 - camada[3])).concat(1) as Rgba;
  return r;
}

function contraste(a: Rgba, b: Rgba): number {
  const lum = (c: Rgba) => {
    const [r, g, bl] = c.slice(0, 3).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

/** Classe `bg-accent-soft` solta — `hover:bg-accent-soft` não pinta em repouso. */
const PINTA_ACCENT_SOFT = /(?:^|\s)bg-accent-soft(?=\s|$)/;

describe("a conversa selecionada é legível no tema escuro", () => {
  it("o fundo da selecionada é o token que muda com o tema, não um degrau fixo da rampa", () => {
    render(<ConversationListItem {...conversaDeExemplo.props} conversation={conversaDeExemplo.conversation} isSelected />);
    const linha = screen.getByRole("button", { current: true });
    expect(linha.className).toContain("bg-accent-soft");
    expect(linha.className).not.toMatch(/\bbg-accent-(50|100|200|300|400|500|600|700|800|900|950)\b/);
  });

  it("a não selecionada não ganha o fundo", () => {
    render(<ConversationListItem {...conversaDeExemplo.props} conversation={conversaDeExemplo.conversation} isSelected={false} />);
    const linha = screen.getByRole("button");
    expect(linha.getAttribute("aria-current")).toBeNull();
    expect(linha.className).not.toContain("bg-accent-soft");
  });

  it("aberta E marcada no lote: o accent-soft é pintado uma vez só (no escuro ele é translúcido e somava)", () => {
    render(
      <ConversationListItem
        {...conversaDeExemplo.props}
        conversation={conversaDeExemplo.conversation}
        isSelected
        selecionado
        onAlternarSelecao={() => {}}
      />,
    );
    const pintam: Element[] = [];
    for (let el: Element | null = screen.getByText("bom dia"); el; el = el.parentElement) {
      if (PINTA_ACCENT_SOFT.test(el.getAttribute("class") ?? "")) pintam.push(el);
    }
    expect(pintam).toHaveLength(1);
  });

  it("aberta E marcada: hover e foco não pintam o botão (senão a linha fica em dois tons) e o foco vira anel", () => {
    render(
      <ConversationListItem
        {...conversaDeExemplo.props}
        conversation={conversaDeExemplo.conversation}
        isSelected
        selecionado
        onAlternarSelecao={() => {}}
      />,
    );
    const classes = (screen.getByRole("button", { current: true }).getAttribute("class") ?? "").split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["hover:bg-transparent", "focus-visible:bg-transparent", "focus-visible:ring-2"]));
    expect(classes.filter((c) => /^(hover|focus-visible):bg-(?!transparent$)/.test(c))).toEqual([]);
  });

  it.each(["dark", "light"] as const)("na aberta, a prévia tem contraste ≥ 4,5 sobre o accent-soft (%s)", (tema) => {
    render(<ConversationListItem {...conversaDeExemplo.props} conversation={conversaDeExemplo.conversation} isSelected />);
    const classe = screen.getByText("bom dia").closest("p")?.getAttribute("class") ?? "";
    const m = classe.match(/(?:^|\s)text-(text(?:-muted|-subtle)?)(?=\s|$)/);
    expect(m?.[1], `classe de cor da prévia: ${classe}`).toBeTruthy();
    const fundo = sobre(cor(token(tema, "--color-accent-soft")), cor(token(tema, "--color-bg")));
    const valor = contraste(cor(token(tema, `--color-${m![1]}`)), fundo);
    expect(valor, `prévia ${m![1]} no ${tema}: ${valor.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
  });
});
