/**
 * "KANBAN" NÃO VOLTA PARA A INTERFACE. "PIPELINE" VOLTOU (decisão de 15/10).
 *
 * ═══ O QUE ISTO GUARDOU ATÉ 15/10 ═══
 *
 * O produto tinha CINCO vocabulários para a mesma coisa, e três deles chegavam
 * ao usuário no MESMO viewport: o `<h1>` de /app/kanban dizia "Pipelines", o
 * estado vazio logo abaixo dizia "Sem pipelines configurados", e o botão abaixo
 * dele dizia "Criar meu primeiro funil". No menu, "Kanban" e "Funis" eram dois
 * itens vizinhos que listavam as MESMAS linhas de `crm_pipelines`. A regra
 * daquela época: "funil" é a única palavra, "pipeline" é de quem construiu o
 * sistema e não do público que vende.
 *
 * ═══ A REVERSÃO DE 15/10 ═══
 *
 * O dono do produto pediu de volta "Pipeline" — rótulo do menu (agora também o
 * primeiro grupo), título da tela de /app/kanban, estado vazio e os botões de
 * criar/importar nessa MESMA tela (ver `lib/navigation/catalogo.ts` e
 * `app/app/kanban/_client.tsx`). Esta reversão é PARCIAL, de propósito: o
 * quadro de um pipeline aberto (`/app/pipelines/[id]`), o dossiê do negócio, a
 * tela "Etapas do funil" (Configurações) e as automações continuam dizendo
 * "funil" — não foram tocados, e por isso o teste abaixo não proíbe mais
 * "pipeline" em lugar nenhum (proibiria o que acabou de ser pedido).
 *
 * O que FICA proibido é "kanban": nunca foi a palavra escolhida em nenhuma das
 * duas rodadas, é nome de padrão de engenharia (o ícone importado se chama
 * `Kanban`), e deixá-lo vazar seria o MESMO defeito que motivou o teste
 * original, só que por um vetor diferente.
 *
 * ⚠️ O QUE ESTE TESTE NÃO PROÍBE: `pipeline`/`kanban` como identificador. A
 * rota é `/app/pipelines/[id]`, a tabela é `crm_pipelines`, o campo é
 * `pipeline_ids` e o ícone importado se chama `Kanban`. Nada disso é lido por
 * quem usa o produto; renomeá-los seria custo sem ganho, e um teste que os
 * proibisse viraria ruído que se aprende a silenciar.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NAV_DESTINATIONS } from "@/lib/navigation/registry";

/**
 * `app/design` é o catálogo interno de componentes — uma tela de quem CONSTRÓI o
 * produto, não de quem o usa. Lá "Kanban · pipeline de pedidos" é o nome correto
 * do padrão que está sendo demonstrado.
 */
const FORA = ["design"];

function telas(raiz: string): string[] {
  const saida: string[] = [];
  const andar = (dir: string) => {
    for (const nome of readdirSync(dir)) {
      const caminho = join(dir, nome);
      if (statSync(caminho).isDirectory()) {
        if (nome === "node_modules" || nome === ".next" || FORA.includes(nome)) continue;
        andar(caminho);
      } else if (/\.tsx$/.test(nome) && !/\.test\.tsx$/.test(nome)) {
        saida.push(caminho);
      }
    }
  };
  andar(raiz);
  return saida;
}

const ARQUIVOS = [...telas("app"), ...telas("components")];

/** Palavra do sistema que não pode virar texto de tela — "pipeline" saiu da
 * lista em 15/10 (ver cabeçalho): é a palavra escolhida agora para a lista de
 * pipelines, e proibi-la reprovaria a própria mudança pedida. */
const PROIBIDAS = /\bkanban\b/i;

/**
 * Texto que o usuário LÊ, extraído sem parser: conteúdo entre `>` e `<` de JSX,
 * e valores de props que são texto por contrato.
 */
function textosVisiveis(src: string): string[] {
  const achados: string[] = [];

  for (const m of src.matchAll(/>([^<>{}\n][^<>{}]*)</g)) {
    const t = (m[1] ?? "").trim();
    // Comentário não é texto de tela. Sem este filtro, um `/** … do pipeline */`
    // logo depois de um `>` (de um genérico ou de um JSX acima) entra como se
    // fosse copy — e um teste que acusa o que não é defeito se aprende a ignorar.
    if (/^[/*]|\*\//.test(t)) continue;
    if (t.length > 2) achados.push(t);
  }

  const props = /\b(headline|subcopy|placeholder|title|label|aria-label|description|alt)\s*=\s*"([^"]+)"/g;
  for (const m of src.matchAll(props)) achados.push(m[2] ?? "");

  return achados;
}

describe("o vocabulário do funil na interface", () => {
  it("nenhuma tela mostra 'kanban' ao usuário", () => {
    const infratores: string[] = [];
    for (const f of ARQUIVOS) {
      const src = readFileSync(f, "utf8");
      for (const t of textosVisiveis(src)) {
        if (PROIBIDAS.test(t)) infratores.push(`${f} → ${t.slice(0, 80)}`);
      }
    }
    expect(
      infratores,
      "nome de padrão de engenharia em texto de tela — use 'pipeline', 'funil', 'etapa' ou 'quadro'",
    ).toEqual([]);
  });

  it("nenhum item de menu se chama 'Kanban'", () => {
    const ruins = NAV_DESTINATIONS.filter((d) => PROIBIDAS.test(d.label));
    expect(ruins.map((d) => d.label)).toEqual([]);
  });

  it("nenhuma descrição do registro usa palavra do sistema", () => {
    // As descrições alimentam o menu, a busca ⌘K, o hub E o tour do fim do
    // onboarding — quatro superfícies de uma vez.
    const ruins = NAV_DESTINATIONS.filter((d) => PROIBIDAS.test(d.description));
    expect(ruins.map((d) => `${d.label}: ${d.description}`)).toEqual([]);
  });

  it("os dois destinos de funil têm nomes DIFERENTES", () => {
    // Eles listavam as mesmas linhas de `crm_pipelines`, lado a lado no grupo
    // CRM, e um deles se chamava "Kanban" — que não é o que a tela mostra.
    const lista = NAV_DESTINATIONS.find((d) => d.href === "/app/kanban");
    const etapas = NAV_DESTINATIONS.find((d) => d.href === "/app/settings/tenant/pipelines");
    expect(lista?.label).toBeTruthy();
    expect(etapas?.label).toBeTruthy();
    expect(lista?.label).not.toBe(etapas?.label);
  });

  it("dois itens do mesmo grupo nunca compartilham rótulo", () => {
    // A colisão que motivou a regra: com os dois chamados "Funis", o menu tinha
    // dois links indistinguíveis e `getByRole("link", { name: "Funis" })`
    // passava a falhar por AMBIGUIDADE — um modo de falha que não parece
    // vocabulário, e sim teste quebrado.
    const porGrupo = new Map<string, string[]>();
    for (const d of NAV_DESTINATIONS.filter((x) => x.sidebar)) {
      porGrupo.set(d.group, [...(porGrupo.get(d.group) ?? []), d.label]);
    }
    for (const [grupo, labels] of porGrupo) {
      const dups = labels.filter((l, i) => labels.indexOf(l) !== i);
      expect(dups, `rótulo repetido no grupo ${grupo}`).toEqual([]);
    }
  });
});
