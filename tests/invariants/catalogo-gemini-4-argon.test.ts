/**
 * O Gemini 4 Argon (migration 0703) chega a quem instala e a quem atualiza.
 *
 * Roda contra o Postgres efêmero nascido do `baseline.sql`. Fica em arquivo
 * próprio porque `catalogo-de-modelos.test.ts` é invariante congelado.
 *
 * A procedência importa pelo mesmo motivo escrito lá: `test-db.sh` aplica o
 * baseline duas vezes, e o backfill da 0068 cura um preço que faltou. Só o
 * `notes` começando com `catálogo` prova que o preço veio do apêndice — que é
 * o que a instalação fresca, de passada única, recebe.
 */
import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

describe("catálogo — Gemini 4 Argon", () => {
  it("aparece no seletor do agente (ferramentas e visão) sem virar o padrão do Google", () => {
    const out = sql(
      `select provider || '|' || model_id || '|' || supports_tools || '|' ||
              supports_vision || '|' || is_default_for_provider
         from public.ai_models
        where provider = 'google' and model_id = 'gemini-4-argon'
          and deprecated_at is null;`,
    );
    expect(out.trim()).toBe("google|gemini-4-argon|true|true|false");
  });

  it("tem o mesmo preço nas duas tabelas, vindo do apêndice e não da cura automática", () => {
    const out = sql(
      `select m.input_price_per_million_cents || '|' || m.output_price_per_million_cents || '|' ||
              p.prompt_cents_per_million_tokens::int || '|' || p.completion_cents_per_million_tokens::int || '|' ||
              (p.notes like 'catálogo%')
         from public.ai_models m
         join public.ai_pricing p on p.model = m.model_id
        where m.provider = 'google' and m.model_id = 'gemini-4-argon';`,
    );
    expect(out.trim()).toBe("400|2000|400|2000|true");
  });
});
