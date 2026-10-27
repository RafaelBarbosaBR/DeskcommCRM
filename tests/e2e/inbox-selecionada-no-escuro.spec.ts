/**
 * A CONVERSA SELECIONADA NO TEMA ESCURO — provada pela tela, com a cor medida.
 *
 * ## O defeito
 *
 * No tema escuro, a linha selecionada da lista do Inbox ficava quase branca
 * (`bg-accent-50`: os degraus da rampa `accent-*` têm o MESMO hex nos dois
 * temas) e o nome do contato, `text-text` — claro no escuro —, sumia: branco
 * sobre branco. Relatado por uma operação real com a captura de tela.
 *
 * ## O que esta spec mede que o teste de componente não mede
 *
 * O CONTRASTE de verdade: a cor computada do nome contra o fundo EFETIVO da
 * linha (o `accent-soft` do escuro é translúcido e compõe sobre os ancestrais).
 * O teste de componente (`tests/unit/selecionada-legivel-no-escuro.test.tsx`)
 * só garante a classe; esta spec garante que a classe resolve em algo legível.
 *
 * Pré-requisitos (banco local, app buildada):
 *   pnpm exec tsx scripts/seed-e2e-credentials.ts
 *   pnpm e2e:env && pnpm e2e:build
 *   E2E_PORT=3021 pnpm exec playwright test tests/e2e/inbox-selecionada-no-escuro.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "./helpers/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence/inbox-selecionada-no-escuro");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PREFIXO = "Selecionada no Escuro E2E";
const NOME_DO_CONTATO = `${PREFIXO} ${Date.now()}`;
const MENSAGEM = "Oi, ainda tem disponível?";

let creds: Creds;
let conversaId = "";

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function limpar(): Promise<void> {
  const { data } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", creds.org_id)
    .like("display_name", `${PREFIXO}%`);
  const ids = ((data as Array<{ id: string }> | null) ?? []).map((c) => c.id);
  if (ids.length === 0) return;
  await admin.from("messages").delete().in("contact_id", ids);
  await admin.from("conversations").delete().in("contact_id", ids);
  await admin.from("contacts").delete().in("id", ids);
}

/**
 * Contraste WCAG entre a cor computada do elemento e o fundo EFETIVO atrás
 * dele, e esse fundo (rgb). O fundo da selecionada é translúcido no escuro:
 * compõe as camadas dos ancestrais até a primeira opaca, de baixo para cima.
 */
function medir(el: Element): { contraste: number; fundo: [number, number, number] } {
  const rgba = (s: string) => {
    const n = s.match(/[\d.]+/g)!.map(Number);
    return { r: n[0]!, g: n[1]!, b: n[2]!, a: n[3] ?? 1 };
  };
  const camadas: Array<{ r: number; g: number; b: number; a: number }> = [];
  for (let no: Element | null = el; no; no = no.parentElement) {
    const c = rgba(getComputedStyle(no).backgroundColor);
    if (c.a > 0) camadas.push(c);
    if (c.a >= 1) break;
  }
  let fundo = { r: 255, g: 255, b: 255 };
  for (const c of camadas.reverse()) {
    fundo = { r: c.r * c.a + fundo.r * (1 - c.a), g: c.g * c.a + fundo.g * (1 - c.a), b: c.b * c.a + fundo.b * (1 - c.a) };
  }
  const texto = rgba(getComputedStyle(el).color);
  const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const [a, b] = [lum(texto), lum(fundo)].sort((x, y) => y - x);
  return { contraste: (a! + 0.05) / (b! + 0.05), fundo: [fundo.r, fundo.g, fundo.b].map(Math.round) as [number, number, number] };
}

test.describe("Inbox — a conversa selecionada é legível no tema escuro", () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    if (!fs.existsSync(CREDS_PATH)) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    await limpar();

    const { data: sessaoExistente } = await admin
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", creds.org_id)
      .limit(1)
      .maybeSingle();
    let sessaoId = (sessaoExistente as { id: string } | null)?.id ?? null;
    if (!sessaoId) {
      const { data, error } = await admin
        .from("channel_sessions")
        .insert({
          organization_id: creds.org_id,
          waha_session_name: `e2e-selecionada-no-escuro-${Date.now()}`,
          webhook_secret_encrypted: "e2e",
        })
        .select("id")
        .single();
      if (error) throw new Error(`channel_sessions: ${error.message}`);
      sessaoId = (data as { id: string }).id;
    }

    const agora = new Date().toISOString();
    const { data: contato, error: erroContato } = await admin
      .from("contacts")
      .insert({
        organization_id: creds.org_id,
        display_name: NOME_DO_CONTATO,
        phone_number: `+55119${String(Date.now()).slice(-8)}`,
      })
      .select("id")
      .single();
    if (erroContato) throw new Error(`contacts: ${erroContato.message}`);
    const contatoId = (contato as { id: string }).id;

    const { data: conversa, error: erroConversa } = await admin
      .from("conversations")
      .insert({
        organization_id: creds.org_id,
        contact_id: contatoId,
        channel_session_id: sessaoId,
        status: "open",
        last_message_at: agora,
        last_inbound_at: agora,
        last_message_preview: MENSAGEM,
      })
      .select("id")
      .single();
    if (erroConversa) throw new Error(`conversations: ${erroConversa.message}`);
    conversaId = (conversa as { id: string }).id;

    const { error } = await admin.from("messages").insert({
      organization_id: creds.org_id,
      conversation_id: conversaId,
      channel_session_id: sessaoId,
      contact_id: contatoId,
      direction: "inbound",
      status: "received",
      sent_via: "external_device",
      type: "text",
      body: MENSAGEM,
      sent_at: agora,
    });
    if (error) throw new Error(`messages: ${error.message}`);
  });

  test.afterAll(async () => {
    await limpar();
  });

  test("no tema escuro, nome e prévia da conversa aberta têm contraste ≥ 4,5, também marcada no lote", async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("deskcomm-theme", "dark");
      } catch {
        /* sem storage o teste reprova no poll abaixo, que é o que deve acontecer */
      }
    });
    await login(page, creds.users.agent!.email, creds.password);
    // Direto na URL final: `/app/inbox/<id>` REDIRECIONA para `?id=`, e um
    // `evaluate` durante o redirect morre com "Execution context was destroyed"
    // (e2e-parte 5, run 38831202800).
    await page.goto(`/app/inbox?filter=all&id=${conversaId}`);

    const linha = page.locator(`[data-conversation-id="${conversaId}"]`);
    await expect(linha).toHaveAttribute("aria-current", "true", { timeout: 60_000 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-theme")))
      .toBe("dark");
    const nome = linha.getByText(NOME_DO_CONTATO, { exact: true });
    const previa = linha.locator("p", { hasText: MENSAGEM });
    await expect(nome).toBeVisible();
    await expect(previa).toBeVisible();

    const medidas: string[] = [];
    // Poll, não leitura única: o botão tem `transition-colors`, e uma leitura
    // no meio da transição mede uma cor que nunca fica na tela.
    const exigir = async (rotulo: string, alvo: typeof nome) => {
      let ultimo = 0;
      await expect
        .poll(async () => (ultimo = (await alvo.evaluate(medir)).contraste), { message: rotulo })
        .toBeGreaterThanOrEqual(4.5);
      medidas.push(`${rotulo}: ${ultimo.toFixed(2)}`);
    };
    await exigir("aberta, nome", nome);
    await exigir("aberta, prévia", previa);

    // A captura com a conversa carregada (lista + thread), e os números ao lado.
    await expect(page.getByText(MENSAGEM, { exact: true })).toHaveCount(2, { timeout: 60_000 });
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCIA, "01-selecionada-no-escuro.png"), animations: "disabled" });

    // ABERTA E MARCADA NO LOTE: o wrapper da linha pinta o `accent-soft`; se o
    // botão também pintasse, a camada translúcida somava (prévia a 3,2:1).
    const caixa = page.getByTestId(`selecao-em-lote-${conversaId}`);
    await caixa.click();
    await expect(caixa).toHaveAttribute("aria-checked", "true");
    await exigir("aberta+marcada, nome", nome);
    await exigir("aberta+marcada, prévia", previa);

    // Hover e foco não podem partir a linha em dois tons (coluna da caixa verde,
    // resto cinza): o fundo atrás da prévia é o MESMO do wrapper.
    const wrapper = linha.locator("xpath=..");
    const mesmoFundo = async (rotulo: string) => {
      let par = "";
      await expect
        .poll(
          async () => {
            const [p, w] = [(await previa.evaluate(medir)).fundo, (await wrapper.evaluate(medir)).fundo];
            return (par = `prévia ${p.join(",")} / wrapper ${w.join(",")}`);
          },
          { message: `${rotulo}: o fundo atrás da prévia tem de ser o do wrapper` },
        )
        .toMatch(/^prévia (\S+) \/ wrapper \1$/);
      medidas.push(`${rotulo}: ${par}`);
    };
    await linha.hover();
    await mesmoFundo("aberta+marcada, hover");
    await exigir("aberta+marcada, hover, prévia", previa);
    await page.mouse.move(0, 0);
    await page.keyboard.press("Tab"); // da caixa para o botão da linha, por teclado (:focus-visible)
    await expect(linha).toBeFocused();
    await mesmoFundo("aberta+marcada, foco");
    // O foco continua visível: vira anel, já que o fundo não muda.
    expect(await linha.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");

    await page.screenshot({ path: path.join(EVIDENCIA, "02-aberta-e-marcada-com-foco.png"), animations: "disabled" });
    fs.writeFileSync(path.join(EVIDENCIA, "01-contraste.txt"), medidas.join("\n") + "\n");
  });
});
