import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import type { Logger } from "@/lib/agent-engine/obs/logger";
import {
  _esquecerPrecosDoCatalogoParaTestes,
  custoDoModeloForaDoMotor,
  precoDaInstalacao,
} from "@/lib/agent-engine/edge/llm/pricing-do-catalogo";

/**
 * #3034 — o preço do catálogo da instalação, lido por um Postgres DE VERDADE.
 *
 * Os testes unitários do módulo usam um dublê de `pg.Pool` que não valida SQL:
 * nem a contagem de parâmetros, nem o nome das colunas, nem o tipo de
 * `unnest(... ) with ordinality`. Na triagem, a primeira versão passava `[ids,
 * provider]` para uma consulta que só referencia `$1` — o Postgres recusa o
 * bind ("bind message supplies 2 parameters, but prepared statement requires
 * 1"), o `catch` devolvia `null` e o custo seguia nulo em TODA chamada, com os
 * 134 testes do dublê verdes. Este arquivo é a camada que o dublê não alcança:
 * o SQL do módulo contra o schema do `baseline.sql` que o self-hoster aplica.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const SO_NA_TABELA = "triagem-3034/so-na-tabela-120b";
const NOS_DOIS = "triagem-3034/nos-dois";

beforeAll(async () => {
  // Preço da issue (#3013): 15/60 centavos por milhão, só em ai_pricing.
  await pool.query(
    `insert into public.ai_pricing (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens)
     values ($1, 15, 60)`,
    [SO_NA_TABELA],
  );
  // Nos dois: o catálogo (linha viva) tem de vencer a tabela derivada.
  await pool.query(
    `insert into public.ai_pricing (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens)
     values ($1, 999, 999)`,
    [NOS_DOIS],
  );
  await pool.query(
    `insert into public.ai_models (provider, model_id, display_name, input_price_per_million_cents, output_price_per_million_cents)
     values ('openrouter', $1, 'triagem 3034', 10, 40)`,
    [NOS_DOIS],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("preço do catálogo da instalação — SQL contra o schema real", () => {
  it("linha só em ai_pricing: o Postgres aceita a consulta e o preço sai", async () => {
    _esquecerPrecosDoCatalogoParaTestes();
    const preco = await precoDaInstalacao(pool, SO_NA_TABELA, "custom");
    expect(preco).toEqual({
      entradaCentsPorMilhao: 15,
      saidaCentsPorMilhao: 60,
      origem: "tabela_de_preco",
    });
  });

  it("o caso da issue em centavos: 2 MTok de entrada + 1 MTok de saída = 90", async () => {
    _esquecerPrecosDoCatalogoParaTestes();
    const custo = await custoDoModeloForaDoMotor(pool, {
      model: SO_NA_TABELA,
      provider: "custom",
      usage: {
        inputTokens: 2_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });
    expect(custo).toBe(90);
  });

  it("linha nos dois: ai_models vence ai_pricing", async () => {
    _esquecerPrecosDoCatalogoParaTestes();
    const preco = await precoDaInstalacao(pool, NOS_DOIS, "custom");
    expect(preco).toEqual({
      entradaCentsPorMilhao: 10,
      saidaCentsPorMilhao: 40,
      origem: "catalogo",
    });
  });

  it("id que não está em tabela nenhuma: null, e não por erro de consulta", async () => {
    _esquecerPrecosDoCatalogoParaTestes();
    const avisos: string[] = [];
    const log: Logger = {
      info: () => undefined,
      warn: (msg) => avisos.push(msg),
      error: (msg) => avisos.push(msg),
    };
    const custo = await custoDoModeloForaDoMotor(pool, {
      model: "triagem-3034/nao-existe",
      provider: "custom",
      usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      log,
    });
    expect(custo).toBeNull();
    // O aviso é o de SEM PREÇO — nenhum aviso de leitura que falhou.
    expect(avisos).toEqual([
      "llm: modelo sem preço no motor nem no catálogo — a chamada grava custo nulo",
    ]);
  });
});
