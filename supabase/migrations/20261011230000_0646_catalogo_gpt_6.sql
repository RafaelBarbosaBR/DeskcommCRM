-- manifest: adiciona ao catálogo os GPT-6 que a OpenAI já serve (gpt-6-luna, gpt-6.1-sol, gpt-6-astra) em ai_models + ai_pricing, para aparecerem em Provedores de IA e no seletor do agente e serem contabilizados no orçamento.
--
-- O catálogo da OpenAI parou na linha 5.6 (migration 0104): quem instala hoje
-- não consegue escolher a geração 6 — e o gpt-6-luna sai mais barato que o gpt-5.6-luna.
--
-- Ids, janela de contexto e preços conferidos na documentação oficial, NÃO na API:
--   developers.openai.com/api/docs/models/<id> e developers.openai.com/api/docs/pricing
--   (tabela Standard), consultadas em 11/10/2026.
-- ⚠️ Sem chave OpenAI nesta máquina: os ids NÃO foram conferidos em
-- GET /v1/models, como a 0104 fez com os dela. `released_at` fica NULL: as
-- páginas não publicam data.
--
-- Preços (centavos por milhão de tokens, entrada/saída), prompt até 272 mil tokens:
--   gpt-6-luna ...........   10 /   50  ($0,10 / $0,50)
--   gpt-6.1-sol ..........  200 / 1000  ($2 / $10)
--   gpt-6-astra .......... 1000 / 5000  ($10 / $50)
-- Acima de 272 mil tokens de entrada, os três cobram 2× a entrada e 1,5× a saída.
-- A coluna só guarda um preço, e vale o da faixa comum.
--
-- Fora: gpt-6-sol. Está na página de preços, mas o gpt-6.1-sol o sucede pelo
-- mesmo preço, com cache mais barato.
--
-- NÃO mexe no padrão da OpenAI (segue gpt-5.6-terra). Idempotente nas duas
-- tabelas (on conflict do update). O invariante tests/invariants/catalogo-de-modelos.test.ts
-- exige preço IGUAL nos dois lados e notes começando com 'catálogo'.
-- supports_tools = true: senão o modelo não aparece no seletor do agente.

-- ---------------------------------------------------------------------------
-- 1. catálogo (o que a tela oferece)
-- ---------------------------------------------------------------------------
insert into public.ai_models
  (provider, model_id, display_name, description, context_window,
   input_price_per_million_cents, output_price_per_million_cents, supports_tools)
values
  ('openai', 'gpt-6-luna', 'GPT-6 Luna',
   'O mais barato da linha 6, para atendimento de alto volume e classificação.',
   1050000, 10, 50, true),
  ('openai', 'gpt-6.1-sol', 'GPT-6.1 Sol',
   'Equilíbrio de custo e capacidade da linha 6.',
   1050000, 200, 1000, true),
  ('openai', 'gpt-6-astra', 'GPT-6 Astra',
   'O mais capaz da OpenAI; custo alto.',
   1050000, 1000, 5000, true)
on conflict (provider, model_id) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  context_window = excluded.context_window,
  input_price_per_million_cents = excluded.input_price_per_million_cents,
  output_price_per_million_cents = excluded.output_price_per_million_cents,
  supports_tools = excluded.supports_tools,
  deprecated_at = null;

-- ---------------------------------------------------------------------------
-- 2. contabilidade de custo — a MESMA lista, mesmos números (senão o gasto é
--    somado com preço de outro modelo, ou não é somado e some do orçamento).
-- ---------------------------------------------------------------------------
insert into public.ai_pricing
  (model, prompt_cents_per_million_tokens, completion_cents_per_million_tokens, notes)
values
  ('gpt-6-luna',     10,   50, 'catálogo 0646 — acima de 272k tokens de entrada, 20/75'),
  ('gpt-6.1-sol',   200, 1000, 'catálogo 0646 — acima de 272k tokens de entrada, 400/1500'),
  ('gpt-6-astra',  1000, 5000, 'catálogo 0646 — acima de 272k tokens de entrada, 2000/7500')
on conflict (model) do update set
  prompt_cents_per_million_tokens = excluded.prompt_cents_per_million_tokens,
  completion_cents_per_million_tokens = excluded.completion_cents_per_million_tokens,
  notes = excluded.notes,
  superseded_at = null;
