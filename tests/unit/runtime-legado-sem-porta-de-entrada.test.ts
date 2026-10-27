/**
 * O runner legado (`runAgent`, em `lib/ai/runtime/agent.ts`) não tem mais porta de entrada HTTP.
 *
 * A rota `POST /api/internal/agents/run` executava um `ai_agent_runs` com o `runAgent`, aceitando
 * como credencial o `INTERNAL_SECRET` — o mesmo segredo que o agendador usa para chamar os crons.
 * Desde a Fase 0 da convergência (spec 2026-07-23) ninguém a chamava: o dispatcher nativo
 * (`lib/ai/dispatcher/index.ts`) não tinha importador, e o cron `agent-dispatcher` é no-op. Mas a
 * rota seguia publicada, e por ela o turno rodava fora do motor de produção (`lib/agent-engine`):
 * sem a lista de bloqueio das ferramentas do turno e sem o `runBeforeSend` antes de enviar.
 *
 * Quem tinha o segredo do agendador tinha, de brinde, um executor de agente sem as cercas do
 * motor. A rota, o dispatcher e o que só eles usavam saíram; o `runAgent` fica (um script de
 * prova o chama direto, sem HTTP). Este arquivo reprova a volta da porta.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const PORTA = "/api/internal/agents/run";

const REMOVIDOS = [
  "app/api/internal/agents/run/route.ts",
  "lib/ai/dispatcher/index.ts",
  "lib/ai/dispatcher/triggers.ts",
];

const RAIZES = ["app", "lib", "workers", "components", "hooks", "scripts", "docker"] as const;
const ARQUIVOS_DE_PROXY = ["Caddyfile", "Caddyfile.single-server", "docker-compose.prod.yml"];

function arquivos(dir: string): string[] {
  if (!existsSync(join(RAIZ, dir))) return [];
  const saida: string[] = [];
  for (const entrada of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
    const rel = posix.join(dir, entrada.name);
    if (entrada.isDirectory()) saida.push(...arquivos(rel));
    else if (/\.(ts|tsx|mjs|js|sh)$/.test(rel) && !/\.test\.(ts|tsx)$/.test(rel)) saida.push(rel);
  }
  return saida;
}

describe("o runner legado não tem porta de entrada HTTP", () => {
  it("a rota interna e o dispatcher que a chamava não existem", () => {
    for (const caminho of REMOVIDOS) {
      expect(existsSync(join(RAIZ, caminho)), `${caminho} voltou`).toBe(false);
    }
  });

  it("nenhum código nem arquivo de proxy aponta para a rota", () => {
    const varridos = [...RAIZES.flatMap((r) => arquivos(r)), ...ARQUIVOS_DE_PROXY];
    // Guarda de vacuidade: uma varredura que não lê nada passaria sem examinar coisa alguma.
    expect(varridos.length).toBeGreaterThan(500);
    const citam = varridos.filter(
      (f) => existsSync(join(RAIZ, f)) && readFileSync(join(RAIZ, f), "utf8").includes(PORTA),
    );
    expect(citam).toEqual([]);
  });
});
