import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * O PONTO DE EXTENSÃO DO CADDY — publicar OUTRO serviço no mesmo VPS sem editar
 * o Caddyfile versionado (#2724).
 *
 * ─── O defeito que esta cerca fecha ────────────────────────────────────────
 *
 * O `Caddyfile` entra no contêiner por bind mount de UM ARQUIVO, e o
 * `update.sh` troca de versão com `git checkout <tag>`. Quem quer publicar uma
 * wiki, um n8n ou uma landing page no mesmo VPS precisava editar o Caddyfile —
 * e com o arquivo alterado a atualização para em "parece haver mudanças locais
 * que divergem". Quem atualiza pela tela do CRM nem vê o motivo: a atualização
 * simplesmente trava. As alternativas eram trocar o proxy inteiro (NPM ou
 * Traefik) ou contratar outro servidor, todas desproporcionais para "só quero
 * um subdomínio a mais".
 *
 * A solução é soltar um arquivo próprio em `caddy-sites/` — pasta que o compose
 * monta em `/etc/caddy/sites` — e deixar o `import /etc/caddy/sites/*.caddy` no
 * final dos DOIS Caddyfiles publicar aquele serviço. Ninguém toca em arquivo
 * versionado, então nada trava a atualização.
 *
 * ─── Por que medir, em vez de só ter escrito ───────────────────────────────
 *
 * Três maneiras de isto ficar certo no papel e quebrado na VPS, cada uma em
 * silêncio. As três foram medidas no `caddy:2-alpine`, não deduzidas:
 *
 *  1. `import` DENTRO de um bloco `{...}` não declara site novo: o arquivo do
 *     operador é interpretado como diretiva no meio do site principal e o
 *     adaptador recusa (`unrecognized directive: base.exemplo.com.br`) — o
 *     proxy inteiro deixa de subir. Indentação não decide nada no Caddyfile,
 *     só a chave decide, por isso a régua abaixo mede PROFUNDIDADE de bloco e
 *     não a coluna em que o `import` foi escrito.
 *  2. `import` e `volumes:` do compose apontando para pastas DIFERENTES: o glob
 *     não acha nada, o Caddy só avisa `No files matching import glob pattern` e
 *     o `caddy validate` continua com exit 0 — a configuração adaptada sai
 *     IDÊNTICA à de antes, byte a byte (medido: 865 = 865). O operador solta o
 *     arquivo, o subdomínio não responde e ninguém explica. É por isso que o
 *     alvo do bind mount é a fonte da verdade da asserção de acoplamento.
 *  3. `caddy-sites/` versionado inteiro: o operador escreve no placeholder, o
 *     `git checkout` da atualização recusa o arquivo local e a trava que esta
 *     issue veio matar volta exatamente igual, por outro caminho.
 *
 * E a outra metade do critério: depois da mudança, a configuração que já
 * existia tem de adaptar para o MESMO JSON de antes (medido contra o
 * `origin/main`) — o CRM continua publicado, com as mesmas rotas e as mesmas
 * proteções.
 */

const RAIZ = process.cwd();

/** Onde o Caddy, DENTRO do contêiner, procura os arquivos do operador. */
const ALVO_NO_CONTAINER = "/etc/caddy/sites";

/** A pasta local, na raiz do projeto — a que o operador escreve. */
const PASTA_LOCAL = "./caddy-sites";

/** O placeholder versionado: mantém a pasta no clone e o glob preenchido. */
const PLACEHOLDER = "caddy-sites/README.caddy";

/**
 * As duas variantes do critério. `docker-compose.prod.yml` é a base das duas
 * (`_common.sh: COMPOSE="docker-compose.prod.yml"`); a single-server entra como
 * override em cima dele.
 */
const VARIANTES = [
  { caddy: "Caddyfile", compose: "docker-compose.prod.yml" },
  { caddy: "Caddyfile.single-server", compose: "docker-compose.single-server.yml" },
] as const;

function ler(rel: string): string {
  return fs.readFileSync(path.join(RAIZ, rel), "utf8");
}

function existe(rel: string): boolean {
  return fs.existsSync(path.join(RAIZ, rel));
}

/**
 * Onde o `import` está — e em que profundidade de bloco.
 *
 * Profundidade, e não indentação: no Caddyfile o que fecha escopo é a chave,
 * não a coluna. Um `import` a zero espaços dentro do `{$DOMAIN} { ... }` também
 * estaria errado, e um `import` indentado no nível de topo funciona (medido).
 */
function medirImporte(texto: string): { numero: number; profundidade: number; ultimaApp: number; quantos: number } {
  let profundidade = 0;
  let ultimaApp = -1;
  let achado: { numero: number; profundidade: number; ultimaApp: number; quantos: number } | null = null;
  let quantos = 0;
  const linhas = texto.split("\n");

  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i]!;
    const conteudo = linha.trim();
    // Linha de comentário não abre nem fecha bloco — e não pode passar por
    // import. Nos dois Caddyfiles não há chave dentro de comentário (medido),
    // então fora isto o cotejo de chaves é exato.
    if (conteudo.startsWith("#")) continue;
    if (/^import\s+\S*\/sites\/\*\.caddy$/.test(conteudo)) {
      quantos += 1;
      achado = { numero: i + 1, profundidade, ultimaApp, quantos };
    }
    if (conteudo.startsWith("reverse_proxy app:3000")) ultimaApp = i + 1;
    profundidade += (linha.match(/\{/g)?.length ?? 0) - (linha.match(/\}/g)?.length ?? 0);
  }

  return achado ?? { numero: -1, profundidade: 0, ultimaApp, quantos: 0 };
}

/**
 * O bloco de UM serviço do compose. Não é parser de YAML: é o suficiente para
 * perguntar "este serviço declara X?", no molde de
 * `tests/unit/portas-do-compose.test.ts`.
 */
function blocoDoServico(yaml: string, nome: string): string {
  const linhas = yaml.split("\n");
  const saida: string[] = [];
  let dentro = false;

  for (const linha of linhas) {
    if (linha.trim() !== "" && !/^\s/.test(linha)) {
      if (dentro) break; // saiu do nível de serviço (`networks:`, `volumes:`…)
    }
    const cabecalho = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(linha);
    if (cabecalho) {
      if (dentro) break;
      dentro = cabecalho[1] === nome;
      continue;
    }
    if (dentro) saida.push(linha);
  }
  return saida.join("\n");
}

describe("o ponto de extensão do Caddy (#2724)", () => {
  it("a sonda enxerga os quatro arquivos — sem isto nada abaixo mede nada", () => {
    // GUARDA DE VAZUIDADE. Um caminho errado devolveria string vazia e as
    // asserções de presença reprovariam, mas as de "não pode conter" passariam
    // como se estivessem vigiando. Por isso o controle positivo: o texto que
    // SABEMOS existir tem de ser achado, com o mesmo leitor dos casos abaixo.
    for (const v of VARIANTES) {
      expect(existe(v.caddy), `${v.caddy} não existe`).toBe(true);
      expect(existe(v.compose), `${v.compose} não existe`).toBe(true);
      expect(ler(v.caddy), `${v.caddy}: a sonda não enxerga o site principal`).toContain(
        "reverse_proxy app:3000",
      );
      expect(blocoDoServico(ler(v.compose), "caddy"), `${v.compose}: parser não achou o serviço caddy`).toContain(
        "volumes:",
      );
    }
    // E o registro que a regra 3 acima depende: a pasta existe no clone.
    expect(existe(PLACEHOLDER), `${PLACEHOLDER} não existe`).toBe(true);
  });

  it.each(VARIANTES)("o $caddy publica os arquivos soltos pelo operador, fora do site principal", (v) => {
    const texto = ler(v.caddy);
    const medido = medirImporte(texto);

    expect(
      medido.quantos,
      `${v.caddy} não tem UM e SÓ UM \`import ${ALVO_NO_CONTAINER}/*.caddy\`. Sem ele nada do que o\n` +
        `operador soltar em ${PASTA_LOCAL}/ é publicado — e é essa a promessa da #2724.`,
    ).toBe(1);

    expect(
      medido.profundidade,
      `${v.caddy}: o import está dentro de um bloco {…} (profundidade ${medido.profundidade}). Ali ele\n` +
        `não declara site nenhum: o arquivo do operador vira diretiva do site principal e o adaptador\n` +
        `recusa (medido: \`unrecognized directive\`), derrubando o proxy inteiro.`,
    ).toBe(0);

    expect(
      medido.numero,
      `${v.caddy}: o import vem ANTES da última \`reverse_proxy app:3000\` — ele tem de ficar no FINAL,\n` +
        `depois do site do produto, para acrescentar sem mexer no que já existe.`,
    ).toBeGreaterThan(medido.ultimaApp);
  });

  it.each(VARIANTES)("o import do $caddy aponta para o MESMO alvo do bind mount do $compose", (v) => {
    // O acoplamento que a falha nº 2 do cabeçalho abre: dois caminhos que
    // precisam coincidir, escritos em DOIS arquivos diferentes. Se divergirem o
    // Caddy valida igual (exit 0), só avisa no log, e o operador fica sem
    // subdomínio e sem explicação. A fonte da verdade é o mount.
    const bloco = blocoDoServico(ler(v.compose), "caddy");
    const mount = `${PASTA_LOCAL}:${ALVO_NO_CONTAINER}:ro`;

    expect(
      bloco,
      `${v.compose}: o serviço caddy não monta \`${mount}\`. Sem o bind mount o glob não acha nada\n` +
        `dentro do contêiner e os arquivos do operador ficam invisíveis.`,
    ).toContain(mount);

    expect(
      bloco,
      `${v.compose}: o mount de ${PASTA_LOCAL} não é somente-leitura. O contêiner não pode gravar em\n` +
        `arquivo de configuração que o operador mantém no host.`,
    ).toContain(`${PASTA_LOCAL}:${ALVO_NO_CONTAINER}:ro`);

    expect(ler(v.caddy)).toContain(`import ${ALVO_NO_CONTAINER}/*.caddy`);
  });

  it("o .gitignore deixa o operador escrever sem virar trava de atualização", () => {
    // A regra 3 do cabeçalho. Ignorar o diretório inteiro é o que impede o
    // `git checkout <tag>` do update.sh de recusar a atualização por causa de
    // um arquivo do operador — que é o MESMO sintoma da issue, pelo mesmo
    // caminho de antes.
    const gitignore = ler(".gitignore");

    expect(
      gitignore.match(/^caddy-sites\/\*$/gm),
      `.gitignore não ignora o conteúdo de caddy-sites/. Arquivo do operador versionado =\n` +
        `atualização recusada com "parece haver mudanças locais que divergem" — o defeito da #2724.`,
    ).not.toBeNull();

    expect(
      gitignore.match(/^!caddy-sites\/README\.caddy$/gm),
      `.gitignore apagou a exceção do placeholder: sem ele a pasta some do clone, o diretório\n` +
        `montado não existe em instalação nova e o operador não tem onde soltar o arquivo.`,
    ).not.toBeNull();
  });

  it("o placeholder versionado não publica site nenhum e mantém o glob preenchido", () => {
    const conteudo = ler(PLACEHOLDER);
    const comConteudo = conteudo
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");

    expect(comConteudo.length, `${PLACEHOLDER} está vazio`).toBeGreaterThan(0);
    expect(
      comConteudo.filter((l) => !l.startsWith("#")),
      `${PLACEHOLDER} tem linha fora de comentário. Ele é versionado e parseado pelo Caddy em TODO o\n` +
        `parque: uma linha ativa nele publica um site a partir do repositório, que é o inverso da #2724.`,
    ).toEqual([]);

    // `README.caddy` casa com o glob `*.caddy` — o que o issue pedia com
    // "manter um README.caddy comentado, para o glob nunca ficar vazio".
    expect(PLACEHOLDER.endsWith(".caddy")).toBe(true);
    expect(conteudo, "o placeholder não explica onde o operador solta o arquivo").toContain(PASTA_LOCAL);
  });

  it.each(VARIANTES)("o caddy do $compose entra na rede própria dos serviços extras", (v) => {
    // O serviço extra é de terceiro (wiki, n8n). Ele entra na `caddy-sites`,
    // que só tem o Caddy, e não na `internal`, que é a dos serviços do CRM.
    // Sem o Caddy nesta rede, o nome do serviço extra não resolve no proxy.
    // Só a declaração de rede conta: o volume `./caddy-sites:` também cita o nome.
    expect(
      blocoDoServico(ler(v.compose), "caddy"),
      `${v.compose}: o serviço caddy não está na rede caddy-sites`,
    ).toMatch(/networks: \[[^\]]*\bcaddy-sites\b[^\]]*\]|^ {6}caddy-sites: \{\}$/m);
  });

  it("a rede dos serviços extras é declarada pela base, ao lado da internal", () => {
    expect(ler("docker-compose.prod.yml")).toMatch(/^networks:\n(?: {2}.*\n| {4}.*\n)*? {2}caddy-sites:\n/m);
  });

  it.each([PLACEHOLDER, "hostgator-setup-kit/README.md"])("o passo a passo de %s recarrega sem derrubar e usa a rede própria", (arquivo) => {
    const texto = ler(arquivo);
    // `restart` com um arquivo errado deixa o Caddy parado e o CRM fora do ar
    // (medido); `reload` recusa o arquivo errado e mantém o que está no ar.
    expect(texto, `${arquivo}: o passo a passo não recarrega com caddy reload`).toContain("caddy reload");
    expect(texto, `${arquivo}: o passo a passo não confere com caddy validate`).toContain("caddy validate");
    expect(texto, `${arquivo}: o passo a passo ainda manda reiniciar o proxy`).not.toMatch(
      /docker compose -f docker-compose\.prod\.yml restart caddy/,
    );
    expect(texto, `${arquivo}: o serviço extra ainda vai para a rede interna do CRM`).not.toContain(
      "--network <nome-do-projeto>_internal",
    );
    expect(texto).toContain("<nome-do-projeto>_caddy-sites");
  });

  it.each(VARIANTES)("a configuração que já existia continua de pé no $caddy", (v) => {
    // A outra metade do critério: acrescentar não pode mudar o resultado do que
    // já estava publicado. O que segue é o contrato de borda do produto, medido
    // também por tests/shell/single-server-installer.test.sh (as seis prefixos
    // do Supabase, o Studio fora) e por tests/unit/portas-do-compose.test.ts.
    const texto = ler(v.caddy);
    expect(texto, "o site principal sumiu").toContain("{$DOMAIN} {");
    expect(texto, "o gzip sumiu").toContain("encode gzip");
    expect(texto, "a rota do webhook global do WAHA perdeu a recusa 403").toContain(
      "@waha_global path /api/v1/webhooks/waha",
    );
    expect(texto, "o respond 403 do webhook global sumiu").toContain("respond @waha_global 403");
    expect(texto, "o app deixou de ser publicado").toContain("reverse_proxy app:3000");

    const bloco = blocoDoServico(ler(v.compose), "caddy");
    // A fonte do mount é o próprio arquivo da variante: `./Caddyfile` na base
    // e `./Caddyfile.single-server` no override — mesmo alvo no contêiner.
    const caddyfileMontado = `./${v.caddy}:/etc/caddy/Caddyfile:ro`;
    expect(
      bloco,
      `${v.compose}: o bind mount do Caddyfile principal sumiu do serviço caddy`,
    ).toContain(caddyfileMontado);
    expect(bloco, "os volumes do Caddy perderam a persistência de certificado").toContain("caddy-data:/data");
  });
});
