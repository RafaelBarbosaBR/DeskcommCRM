/**
 * MEDIDOR DE HOPS DO INBOX — instrumentação SÓ DE TESTE (issue #2399).
 *
 * ─── O que ele mede, e por que nestes elos ─────────────────────────────────
 *
 * O e2e `encerramento-atendimento` falhou (run 37320609105) com pedidos que
 * NUNCA são cancelados (`passagens`, `draft-reply`) levando ~4s no servidor,
 * enquanto o controle aprovado (run 37329560310) fechava a MESMA rajada em
 * <300 ms. A causa não estava medida. Este medidor quebra cada requisição em
 * TRÊS elos, com a régua que o próprio browser expõe (Resource Timing):
 *
 *   elo 1 · fila+envio (browser)  = requestStart - startTime
 *   elo 2 · SERVIDOR (entrada da rota → consulta(s) ao banco → resposta)
 *                                 = responseStart - requestStart  ← o TTFB
 *   elo 3 · transferência         = responseEnd   - responseStart
 *
 * O elo 2 é o que a issue chama de "no servidor": ele só começa a contar quando
 * o socket ENVIOU e termina no primeiro byte. É onde a cadeia de auth
 * (`loadAuthUser` → `fn_user_role_in_org`) + as consultas da rota rodam.
 *
 * ─── O que ele NÃO mede ────────────────────────────────────────────────────
 *
 * O interior do servidor (rota vs banco) — o trace do Playwright não traz
 * perfil. O que dá para afirmar é se o TTFB EXPLICA ou não os ~4s; e a
 * CONTAGEM de GETs por endpoint, que é o outro lado da pergunta (se a rajada é
 * legítima). Medir além disso exigiria instrumentar produção.
 *
 * ─── Sem produção ──────────────────────────────────────────────────────────
 *
 * Nada aqui roda a menos que `E2E_MEDIR_HOPS=1` esteja no ambiente. Fora isso a
 * suíte é idêntica à de antes: o `iniciar` não anexa listener nenhum.
 */
import { mkdirSync, writeFileSync } from "node:fs";

import type { Page, Request } from "@playwright/test";

interface Linha {
  metodo: string;
  caminho: string;
  quando: number;
  // null = cancelada antes do primeiro byte: conta, mas não tem tempo.
  filaMs: number | null;
  servidorMs: number | null;
  transferenciaMs: number | null;
  totalMs: number | null;
  cancelado: boolean;
}

export interface MedidaDeEndpoint {
  metodo: string;
  caminho: string;
  get: number;
  cancelados: number;
  filaMedianaMs: number;
  servidorMedianaMs: number;
  servidorMaxMs: number;
  transferenciaMedianaMs: number;
  totalMedianaMs: number;
}

export class MedidorDeHops {
  private linhas: Linha[] = [];
  private marcos = new Map<string, number>();
  private ativo = false;

  constructor(private readonly page: Page) {}

  /** Anexa os listeners. Sem `E2E_MEDIR_HOPS=1` não faz NADA. */
  iniciar(): void {
    if (process.env.E2E_MEDIR_HOPS !== "1") return;
    this.ativo = true;
    const registrar = (r: Request, cancelado: boolean) => {
      const t = r.timing();
      // Sem timing completo os campos vêm -1. Concluída assim é cache: não
      // entra. CANCELADA assim é aborto antes do primeiro byte — exatamente o
      // cancelamento da lista que a #2399 pergunta: entra, com tempos nulos,
      // para contar em `get`/`cancelados` sem poluir as medianas.
      //
      // ⚠️ `startTime` é EPOCH (ms desde 1970) e TODO o resto é relativo a ele
      // — somar/subtrair `startTime` de `requestStart` dava ~-1,7e12 (clamp em
      // 0, coluna "tot" mentindo). Aqui cada elo é diferença de dois campos
      // RELATIVOS, ou o próprio campo relativo.
      const temTiming = !!t && t.responseStart > 0 && t.responseEnd > 0;
      if (!temTiming && !cancelado) return;
      const url = new URL(r.url());
      this.linhas.push({
        metodo: r.method(),
        caminho: url.pathname + (url.search || ""),
        quando: Date.now(),
        filaMs: temTiming ? Math.max(0, t.requestStart) : null, // espera antes de ENVIAR (rel. ao início)
        servidorMs: temTiming ? Math.max(0, t.responseStart - t.requestStart) : null, // TTFB
        transferenciaMs: temTiming ? Math.max(0, t.responseEnd - t.responseStart) : null,
        totalMs: temTiming ? Math.max(0, t.responseEnd) : null,
        cancelado,
      });
    };
    this.page.on("requestfinished", (r) => registrar(r, false));
    this.page.on("requestfailed", (r) => registrar(r, true));
  }

  /** Marca um instante nomeado (para recortar a janela da asserção). */
  marcar(nome: string): void {
    if (this.ativo) this.marcos.set(nome, Date.now());
  }

  /** Só as requests de API do Next (docs/rotas `/api/`), agrupadas por endpoint.
   *  Com `janela`, recorta pelo instante em que a request terminou. */
  tabela(janela?: { desde?: number; ate?: number }): MedidaDeEndpoint[] {
    const porEndpoint = new Map<string, Linha[]>();
    for (const l of this.linhas) {
      if (!l.caminho.startsWith("/api/")) continue;
      if (janela?.desde !== undefined && l.quando < janela.desde) continue;
      if (janela?.ate !== undefined && l.quando > janela.ate) continue;
      // Normaliza id por UUID para agrupar o MESMO endpoint chamado com ids
      // diferentes — a pergunta é "quantos GET por endpoint", não por linha.
      const chave = `${l.metodo} ${l.caminho
        .split("?")[0]!
        .replace(
          /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
          "/:id",
        )}`;
      (porEndpoint.get(chave) ?? porEndpoint.set(chave, []).get(chave)!).push(l);
    }
    const comTempo = (xs: (number | null)[]): number[] =>
      xs.filter((x): x is number => x !== null);
    const mediana = (xs: (number | null)[]): number => {
      const o = comTempo(xs).sort((a, b) => a - b);
      if (o.length === 0) return 0;
      return Math.round(o[Math.floor(o.length / 2)]!);
    };
    return [...porEndpoint.entries()]
      .map(([chave, ls]) => {
        const [metodo, caminho] = chave.split(" ", 2) as [string, string];
        return {
          metodo,
          caminho,
          get: ls.length,
          cancelados: ls.filter((l) => l.cancelado).length,
          filaMedianaMs: mediana(ls.map((l) => l.filaMs)),
          servidorMedianaMs: mediana(ls.map((l) => l.servidorMs)),
          servidorMaxMs: Math.round(Math.max(0, ...comTempo(ls.map((l) => l.servidorMs)))),
          transferenciaMedianaMs: mediana(ls.map((l) => l.transferenciaMs)),
          totalMedianaMs: mediana(ls.map((l) => l.totalMs)),
        };
      })
      .sort((a, b) => b.totalMedianaMs - a.totalMedianaMs);
  }

  /** Grava a tabela em JSON e imprime no stdout. Devolve o caminho do arquivo. */
  despejar(destinoJson: string): string {
    if (!this.ativo) return "";
    const desde = this.marcos.get("antes_da_entrada_2");
    const ate = this.marcos.get("depois_da_asseracao_240");
    const tabela = this.tabela({ desde, ate });
    mkdirSync(destinoJson.replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(
      destinoJson,
      JSON.stringify({ marcos: Object.fromEntries(this.marcos), janelaMs: ate && desde ? ate - desde : null, tabela }, null, 2),
      "utf8",
    );
    if (ate && desde) console.info(`\n=== HOPS #2399 (E2E_MEDIR_HOPS) — janela da asserção :240 (${ate - desde}ms) ===`);
    console.info(
      "metodo caminho".padEnd(58) + "| n  | canc | envio | srv-med | srv-max | transf | total",
    );
    for (const m of tabela) {
      const esq = `${m.metodo} ${m.caminho}`.slice(0, 57).padEnd(58);
      console.info(
        `${esq}| ${String(m.get).padStart(2)} | ${String(m.cancelados).padStart(4)} | ` +
          `${String(m.filaMedianaMs).padStart(5)} | ${String(m.servidorMedianaMs).padStart(7)} | ` +
          `${String(m.servidorMaxMs).padStart(7)} | ${String(m.transferenciaMedianaMs).padStart(6)} | ` +
          `${String(m.totalMedianaMs).padStart(5)}`,
      );
    }
    console.info(`=== fim HOPS (json em ${destinoJson}) ===\n`);
    return destinoJson;
  }
}
