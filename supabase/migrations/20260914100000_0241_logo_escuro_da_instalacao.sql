-- 0241 — logo escuro da instalação
--
-- `platform_branding` tinha UM slot de logo (`logo_path`), mostrado sobre os
-- dois temas do produto — e `components/branding/CampoDeLogo.tsx` já avisava
-- disso na prévia ("Como o logo aparece nas duas aparências do sistema"),
-- exatamente para pegar o caso em que um logo de texto escuro some no tema
-- escuro. O pedido desta migration é o par de verdade: um segundo arquivo,
-- opcional, mostrado só no tema escuro.
--
-- `logo_dark_path`, sem `logo_dark_url` par: `logo_url` existe porque
-- `APP_LOGO_URL` é semente do `.env` e rede de rollback do `agent.sh` (que
-- reverte a imagem, nunca o banco) — não há `APP_LOGO_URL_DARK` nenhuma para
-- ancorar, então uma URL colada aqui seria contrato sem consumidor. Quem não
-- subiu o arquivo escuro continua com o logo claro nos dois temas —
-- precedência por campo, mesma regra de sempre (`lib/branding/resolve.ts`).
--
-- Mesma forma de `logo_path` (migration 0158): caminho dentro de
-- `brand-logos`, nunca URL (DIRC-C), com o MESMO CHECK de regex — o backfill
-- vem antes da constraint pelo mesmo motivo de lá: o `update.sh` roda sem
-- `ON_ERROR_STOP`, e uma constraint que estourasse deixaria a coluna sem
-- validação em silêncio.

alter table public.platform_branding
  add column if not exists logo_dark_path text;

comment on column public.platform_branding.logo_dark_path is
  'Caminho do arquivo de logo para o TEMA ESCURO em storage/brand-logos, sempre platform/<uuid>.<png|jpg>. Opcional: ausente = o logo claro (logo_path) vale nos dois temas. Sem par de URL — não há semente de .env para um logo escuro. Escrito por app/api/v1/marca/logo/route.ts (variante=escuro).';

update public.platform_branding
   set logo_dark_path = null
 where logo_dark_path is not null
   and logo_dark_path !~ '^platform/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$';

alter table public.platform_branding
  drop constraint if exists platform_branding_logo_dark_path;
alter table public.platform_branding
  add constraint platform_branding_logo_dark_path check (
    logo_dark_path is null
    or logo_dark_path ~ '^platform/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$'
  );

-- ⚠️ CHECK de REGEX, não de conjunto: fica FORA da lista `PARES` de
-- `tests/invariants/vocabulario-banco-x-typescript.test.ts`. Mesma razão de
-- `platform_branding_logo_path`.

notify pgrst, 'reload schema';
