-- 0244 — um terceiro slot de logo: a MARCA do favicon
--
-- O favicon (`app/icon.tsx`) embutia o logo INTEIRO (o lockup horizontal
-- "orbita company") redimensionado pra um quadrado de 64×64 — legível numa
-- tela grande, ilegível numa aba de navegador, onde o nome vira uma mancha.
-- A maioria dos logos de produto resolve isso com um ÍCONE separado da
-- wordmark (o "mark"), não redimensionando a wordmark inteira.
--
-- `favicon_mark_path`, mesma forma de `logo_path`/`logo_dark_path`
-- (migrations 0158/0241): caminho dentro de `brand-logos`, nunca URL, sem
-- par `_url` (não há semente de `.env` pra isto). AUSENTE = o ícone cai no
-- degrade de sempre — o logo inteiro (se houver) ou a cor+inicial gerada
-- (`app/icon.tsx`, `lib/branding/icone.ts`). Nenhuma instalação existente
-- muda de comportamento até alguém subir um arquivo neste slot novo.

alter table public.platform_branding
  add column if not exists favicon_mark_path text;

comment on column public.platform_branding.favicon_mark_path is
  'Caminho do arquivo do ÍCONE (mark, sem o texto da wordmark) para o favicon, em storage/brand-logos, sempre platform/<uuid>.<png|jpg>. Opcional: ausente = o favicon cai no logo inteiro ou na cor+inicial gerada. Escrito por app/api/v1/marca/logo/route.ts (variante=favicon).';

update public.platform_branding
   set favicon_mark_path = null
 where favicon_mark_path is not null
   and favicon_mark_path !~ '^platform/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$';

alter table public.platform_branding
  drop constraint if exists platform_branding_favicon_mark_path;
alter table public.platform_branding
  add constraint platform_branding_favicon_mark_path check (
    favicon_mark_path is null
    or favicon_mark_path ~ '^platform/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$'
  );

notify pgrst, 'reload schema';
