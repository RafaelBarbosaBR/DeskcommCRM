-- manifest: adiciona o Gemini 4 Argon (gemini-4-argon) ao catálogo curado do Google em ai_models + ai_pricing com 400/2000 centavos por milhão, a tarifa Standard de 01/12/2026; costCents e computeCost aplicam a promo (200/1000/10 centavos) até 2026-12-01T00:00:00Z.
--
-- Fontes, lidas em 2026-10-19:
--   ai.google.dev/gemini-api/docs/models/gemini-4-argon — id `gemini-4-argon`
--     (estável); entrada texto/imagem/vídeo/áudio/PDF, saída texto; function
--     calling; janela de 1.048.576 tokens; raciocínio low/medium/high.
--   ai.google.dev/gemini-api/docs/pricing — Standard, faixa paga, por 1M tokens:
--     até 30/11/2026 ........ entrada 2,00 / saída 10,00 / cache 0,10
--     a partir de 01/12/2026  entrada 4,00 / saída 20,00 / cache 0,20
--     Sem faixa acima de 200K; só cache implícito (sem explícito).
--   cloud.google.com/blog (13/10/2026) — lançamento e os mesmos preços.
--
-- Mesmo desenho da 0649: `ai_pricing_pkey` é só `model`, então a tabela guarda
-- UM preço, o posterior à promo, igual nas duas tabelas e com notes começando
-- com `catálogo`. A lista mostra 400/2000; o gasto em llm_calls segue
-- `costCents` (seam) e `computeCost` (sentimento, respondedor legado), que
-- cobram a promo enquanto `em < 2026-12-01T00:00:00Z` (PROMOCOES em pricing.ts).
--
-- Não mexe no default do Google. supports_tools = true: senão o modelo não
-- aparece no seletor do agente. Idempotente nas duas tabelas.

insert into public.ai_models
  (provider, model_id, display_name, description, context_window, released_at,
   supports_vision, input_price_per_million_cents, output_price_per_million_cents, supports_tools)
values
  ('google', 'gemini-4-argon', 'Gemini 4 Argon',
   'O modelo de raciocínio mais capaz do Google; aceita texto, imagem, vídeo, áudio e PDF. Preço de catálogo: tarifa de 01/12/2026 (US$ 4/US$ 20). O motor cobra a promo (US$ 2/US$ 10) até essa data (UTC).',
   1048576, '2026-10-13', true, 400, 2000, true)
on conflict (provider, model_id) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  context_window = excluded.context_window,
  released_at = excluded.released_at,
  supports_vision = excluded.supports_vision,
  input_price_per_million_cents = excluded.input_price_per_million_cents,
  output_price_per_million_cents = excluded.output_price_per_million_cents,
  supports_tools = excluded.supports_tools,
  deprecated_at = null;

insert into public.ai_pricing
  (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens, notes)
values
  ('gemini-4-argon', 400, 2000, 'catálogo 0703 — tarifa de 01/12/2026 UTC; o motor aplica 200/1000 até lá')
on conflict (model) do update set
  prompt_cents_per_million_tokens = excluded.prompt_cents_per_million_tokens,
  completion_cents_per_million_tokens = excluded.completion_cents_per_million_tokens,
  notes = excluded.notes,
  superseded_at = null;
