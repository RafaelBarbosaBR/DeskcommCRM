import { ImageResponse } from "next/og";

import { letraDoIcone } from "@/lib/branding/icone";
import { baseDoStorage, TAMANHO_MAXIMO_DO_LOGO, urlPublicaDoLogo } from "@/lib/branding/logo";
import { marcaDaSaida } from "@/lib/branding/saida";

/**
 * O ícone da aba, DESENHADO em runtime com a marca da instalação.
 *
 * ─── O que existia antes: nada ──────────────────────────────────────────────
 *
 * Zero `app/icon.*`, zero `app/favicon.ico`, zero `public/favicon*` (medido:
 * `public/` tem dois arquivos, `.gitkeep` e `llms.txt`). O navegador pedia
 * `/favicon.ico` por conta própria e recebia 404 — em produção, 19.435 bytes,
 * porque o 404 é a `app/not-found.tsx` INTEIRA servida para um pedido de
 * ícone. Na prática: aba sem marca nenhuma, para nós e para todo revendedor.
 *
 * ─── Por que GERADO, e não um arquivo em `public/` ──────────────────────────
 *
 * `Dockerfile:75-79` copia `public/` para a imagem final, e a imagem é UMA SÓ
 * para todas as marcas — a mesma tag do GHCR que cada clone puxa. Um
 * `favicon.ico` estático resolveria o 404 e entregaria a NOSSA marca na aba de
 * todo revendedor, que é o mesmo modo de falha que `lib/branding.ts:12-16`
 * documenta para `NEXT_PUBLIC_*`: verde em dev, verde no CI, verde na Vercel, e
 * errado exatamente na VPS de quem a feature existe para servir.
 *
 * ─── O ÍCONE entra, mas só do NOSSO bucket — nunca `logo_url` solto ────────
 *
 * `platform_branding.logo_url` é `text` livre, sem CHECK de host
 * (`supabase/baseline.sql:11832-11848`). Buscá-la aqui seria uma requisição de
 * saída disparada pelo `<head>` de TODA página, com a URL vinda de um campo que
 * o operador digita — SSRF com gatilho em cada page load. `logo_path`/
 * `favicon_mark_path` são outra categoria: são arquivo QUE NÓS validamos no
 * upload (bytes farejados, ≤512 KB, nome `<uuid>.<png|jpg>`) e cuja URL
 * pública é sempre `baseDoStorage()` — o projeto Supabase desta instalação,
 * nunca um host que o operador escolhe. Por isso `logoConfiavel()` abaixo só
 * aceita a URL quando ela começa EXATAMENTE pelo prefixo de `brand-logos`
 * desta instalação; qualquer outra coisa (a URL colada no `.env`, ou lixo)
 * cai no mesmo degrade de sempre: cor + inicial. O accent vem do mesmo
 * resolvedor que pinta os e-mails (`marcaDaSaida`) e a fonte
 * (`Geist-Regular.ttf`) vem embutida no `@vercel/og` que o Next já traz.
 *
 * ─── Por que ÍCONE, e não o LOGO INTEIRO ────────────────────────────────────
 *
 * O favicon é o único lugar onde o logo é redimensionado pra 64px — uma
 * wordmark horizontal ("orbita company") vira mancha ilegível nesse
 * tamanho, porque o texto some antes do símbolo. `favicon_mark_path`
 * (migration 0244) é um SEGUNDO arquivo opcional — só o ícone, sem o texto —
 * pensado pra caber num quadrado pequeno. Ausente = cai pro logo inteiro
 * (comportamento de toda instalação antes desta coluna existir), e na
 * ausência dele, cor + inicial.
 *
 * ─── `force-dynamic` não é zelo ─────────────────────────────────────────────
 *
 * O loader de metadata NÃO injeta `force-static` na variante gerada por código
 * (`next-metadata-route-loader.js`, `getSingleImageRouteCode`), mas também não
 * a torna dinâmica sozinha — sem esta linha o `next build` congelaria o ícone
 * dentro da imagem pré-buildada, com a marca de quem buildou. E o defeito seria
 * invisível em dev, em teste e na Vercel: só apareceria na VPS do revendedor,
 * que é o único lugar onde a marca é outra. O loader re-exporta todo named
 * export do arquivo do usuário (`:43`), então declarar aqui basta.
 *
 * ─── Custo ──────────────────────────────────────────────────────────────────
 *
 * Um `ImageResponse` por requisição a `/icon`. O `Cache-Control` abaixo é o que
 * mantém isso em uma renderização por minuto por navegador em vez de uma por
 * navegação. A leitura da marca é a MESMA que o `generateMetadata` do layout já
 * faz, memoizada por 30s (`lib/branding/instalacao.ts:209`) — nenhuma consulta
 * a mais no banco.
 *
 * ⚠️ `/icon` precisa estar em `PUBLIC_PATHS` (`lib/auth/public-paths.ts`): o
 * matcher do `proxy.ts:128` só dispensa caminho COM extensão, e `/icon` não tem
 * — sem a entrada, o ícone responde 307 para `/login` a quem ainda não entrou,
 * que é exatamente a primeira tela que um comprador vê.
 */

export const dynamic = "force-dynamic";

/** 64 e não 32: a aba pede 16-32 CSS px, e em tela retina isso são 32-64 reais. */
export const size = { width: 64, height: 64 };
export const contentType = "image/png";

/**
 * `true` só quando a URL é PROVADAMENTE um arquivo do nosso bucket
 * `brand-logos` desta instalação — o prefixo é montado pela MESMA função que
 * a rota de upload usa para gerar a URL pública (`urlPublicaDoLogo`), nunca
 * redigitado. Qualquer coisa fora disso (a URL colada no `.env`, um valor
 * gravado à mão no banco) devolve `false` — ver o cabeçalho do arquivo.
 */
function logoConfiavel(url: string | null): string | null {
  if (!url) return null;
  const base = baseDoStorage();
  if (!base) return null;
  const prefixo = urlPublicaDoLogo("", base);
  return url.startsWith(prefixo) ? url : null;
}

/**
 * Baixa o logo e devolve como `data:` URI — nunca deixa o `satori` buscar a
 * URL remota sozinho, porque aí um erro de rede lançaria de dentro do
 * `ImageResponse` e derrubaria a aba inteira (o mesmo "nunca lança" do resto
 * deste arquivo). Timeout curto e teto de tamanho: é o MESMO arquivo que a
 * rota de upload já limitou a 512 KB, e o recheck aqui é só desconfiança do
 * dado, não do caminho.
 */
async function comoDataUri(url: string): Promise<string | null> {
  try {
    const resposta = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    if (!resposta.ok) return null;
    const bytes = await resposta.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > TAMANHO_MAXIMO_DO_LOGO) return null;
    const tipo = resposta.headers.get("content-type") ?? "image/png";
    return `data:${tipo};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
}

export default async function Icon() {
  const marca = await marcaDaSaida(null);
  const letra = letraDoIcone(marca.nome);
  // O ÍCONE vence o logo inteiro — ver o cabeçalho. `??`, não `||`: os dois
  // já vêm de `logoConfiavel()` como `string | null`, nunca `""`.
  const urlDaImagem = logoConfiavel(marca.faviconMarkUrl) ?? logoConfiavel(marca.logoUrl);
  const dataUri = urlDaImagem ? await comoDataUri(urlDaImagem) : null;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          // Fundo branco com o logo (pensado para a superfície CLARA do
          // produto — o favicon não tem tema; ver `CampoDeLogo.tsx`), fundo
          // da cor da marca com a inicial no degrade sem logo — mesmo de
          // sempre.
          background: dataUri ? "#ffffff" : marca.accent,
          color: marca.accentFg,
          // 62% da altura: a caixa maiúscula do Geist ocupa ~72% do em, então
          // a letra fica com respiro sem virar um selo minúsculo no meio.
          fontSize: Math.round(size.height * 0.62),
          // O ladrilho é quadrado e cheio: o navegador já arredonda o favicon
          // no chrome dele, e arredondar aqui também produz canto duplo.
          borderRadius: 0,
        }}
      >
        {dataUri ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={dataUri}
            alt=""
            width={Math.round(size.width * 0.86)}
            height={Math.round(size.height * 0.86)}
            style={{ objectFit: "contain" }}
          />
        ) : (
          (letra ?? "")
        )}
      </div>
    ),
    {
      ...size,
      headers: {
        // 60s é deliberado, e o par com o TTL da marca: o operador que troca a
        // cor em `/admin/marca` vê a aba acompanhar dentro de um minuto. Um
        // `immutable` de um ano tornaria a tela de marca uma promessa que o
        // ícone não cumpre; `no-store` faria o satori rodar a cada navegação.
        "cache-control": "public, max-age=60, stale-while-revalidate=600",
      },
    },
  );
}
