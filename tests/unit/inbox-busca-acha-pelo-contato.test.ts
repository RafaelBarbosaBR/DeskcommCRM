/**
 * A BUSCA DO INBOX ACHA PELO NOME E PELO TELEFONE DO CONTATO (issue #341).
 *
 * ─── O defeito, medido em c5b45b24 ──────────────────────────────────────────
 *
 * `app/api/v1/conversations/_handler.ts:146` filtrava só o corpo da mensagem:
 *
 *     if (q.search) {
 *       const s = q.search.trim().replace(/[%_]/g, (m) => `\\${m}`);
 *       query = query.ilike("last_message_preview", `%${s}%`);
 *     }
 *
 * Sonda por qualquer predicado que alcance o contato — só o keyset do cursor
 * aparece. CONTROLE POSITIVO: `grep contacts` no mesmo arquivo ACHA a linha 28,
 * onde o contato é EMBUTIDO no select. Ou seja, o contato está ali e nenhum
 * filtro casa contra ele — a ausência é real, não sonda cega.
 *
 * Pior: nem o corpo inteiro é buscado. `last_message_preview` é só a ÚLTIMA
 * mensagem da conversa, então "busca por conteúdo" já era menos do que promete.
 *
 * Para um atendente, achar a conversa pelo nome do cliente é o caso mais comum —
 * bem mais que lembrar um trecho literal de mensagem. Com milhares de contatos
 * importados, sem isso a única saída é rolar a lista.
 *
 * ─── Por que dois passos, e não um join ─────────────────────────────────────
 *
 * O PostgREST não filtra por coluna de tabela embutida sem transformar o
 * embed em `!inner`, o que mudaria a semântica da lista inteira (conversa sem
 * contato sumiria). Dois passos preservam isso: uma consulta curta em
 * `contacts` da MESMA organização devolve ids, e o predicado vira
 * `or(preview.ilike, contact_id.in.(...))`.
 *
 * O teto de ids é obrigatório, não zelo: a lista viaja na URL do PostgREST, e
 * uma busca por "a" sem limite estoura a requisição.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listConversationsHandler, tokenizarTermoDeBusca } from "@/app/api/v1/conversations/_handler";

interface Chamada {
  tabela: string;
  metodo: string;
  args: unknown[];
}

/**
 * Dublê que registra a cadeia POR TABELA. Registrar sem a tabela não serviria:
 * metade do conserto é a consulta NOVA em `contacts`, e um registro achatado não
 * distinguiria um `ilike` lá de um `ilike` em `conversations`.
 */
function fakeSupabase(contatosEncontrados: Array<{ id: string }>) {
  const chamadas: Chamada[] = [];
  const client = {
    from: (tabela: string) => {
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (ok: (v: unknown) => unknown) =>
                ok({ data: tabela === "contacts" ? contatosEncontrados : [], error: null });
            }
            return (...args: unknown[]) => {
              chamadas.push({ tabela, metodo: String(prop), args });
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
  };
  return { client: client as never, chamadas };
}

const ctx = {
  organization_id: "org-1",
  requestId: "req-1",
  actor: { type: "user" as const, id: "user-1" },
} as never;

async function buscar(search: string, contatos: Array<{ id: string }> = []) {
  const { client, chamadas } = fakeSupabase(contatos);
  await listConversationsHandler(client, ctx, { limit: 50, search } as never);
  return chamadas;
}

/** Todos os argumentos de string entregues a um método, numa tabela. */
const args = (c: Chamada[], tabela: string, metodo: string) =>
  c.filter((x) => x.tabela === tabela && x.metodo === metodo).flatMap((x) => x.args).join(" | ");

beforeEach(() => vi.clearAllMocks());

describe("busca do inbox — o contato entra no predicado", () => {
  it("⭐ o nome do cliente encontra a conversa, mesmo sem aparecer em mensagem nenhuma", async () => {
    const c = await buscar("Maria", [{ id: "contato-maria" }]);

    // 1ª metade: a consulta em contacts existe, é da MESMA organização, e casa
    // os dois campos de nome (o produto usa `display_name` e `name`).
    const nomes = args(c, "contacts", "or");
    expect(nomes, "nenhuma consulta em contacts: a busca segue cega ao nome").toContain(
      "display_name",
    );
    expect(nomes).toContain("name");
    expect(
      args(c, "contacts", "eq"),
      "consulta em contacts sem filtro de organização — service role bypassa RLS",
    ).toContain("org-1");
    expect(
      c.some((x) => x.tabela === "contacts" && x.metodo === "limit"),
      "consulta em contacts sem teto: a lista de ids viaja na URL e uma busca por 'a' estoura a requisição",
    ).toBe(true);

    // 2ª metade: os ids achados entram no predicado da lista, SEM perder o
    // casamento por conteúdo — quem busca um trecho de mensagem continua achando.
    const filtro = args(c, "conversations", "or");
    expect(filtro, "os ids do contato não chegaram ao predicado da lista").toContain(
      "contato-maria",
    );
    expect(filtro, "a busca por conteúdo foi perdida no caminho").toContain(
      "last_message_preview",
    );
  });

  it("⭐ contato anonimizado não volta a ser encontrável pelo nome antigo", async () => {
    // A anonimização é direito do titular. Se a busca voltasse a achá-lo pelo
    // nome, o conserto criaria um vazamento onde não havia.
    const c = await buscar("Maria", [{ id: "contato-maria" }]);
    const filtros = c.filter((x) => x.tabela === "contacts");
    const texto = JSON.stringify(filtros);
    expect(texto, "a varredura de nome não exclui contato anonimizado").toContain(
      "is_anonymized",
    );
  });

  it("telefone com dígitos suficientes também procura o número", async () => {
    const c = await buscar("991234567", [{ id: "contato-tel" }]);
    expect(args(c, "contacts", "or")).toContain("phone_number");
  });

  it("termo curto de dígitos não vira busca de telefone", async () => {
    // "12" casaria metade da base e devolveria a lista inteira embaralhada —
    // pior que não achar, porque parece que a busca funcionou.
    const c = await buscar("12", []);
    expect(args(c, "contacts", "or")).not.toContain("phone_number");
  });

  it("sem contato casado, a busca por conteúdo continua funcionando sozinha", async () => {
    const c = await buscar("orçamento", []);
    const conv = c.filter((x) => x.tabela === "conversations");
    const texto = JSON.stringify(conv);
    expect(texto).toContain("last_message_preview");
    // Sem ids, um `contact_id.in.()` vazio viraria SQL inválido no PostgREST.
    expect(texto, "montou um `in` vazio, que o PostgREST recusa").not.toContain("contact_id.in.()");
  });

  it("sem termo de busca, nada de contatos é consultado", async () => {
    const { client, chamadas } = fakeSupabase([]);
    await listConversationsHandler(client, ctx, { limit: 50 } as never);
    expect(
      chamadas.filter((x) => x.tabela === "contacts"),
      "consultou contatos sem ninguém ter buscado — uma ida ao banco por listagem",
    ).toEqual([]);
  });
});

describe("tokenizarTermoDeBusca — 'Paulo Jr' ~ 'Paulo Lima Jr'", () => {
  it("separa por espaço", () => {
    expect(tokenizarTermoDeBusca("Paulo Jr")).toEqual(["Paulo", "Jr"]);
  });
  it("vírgula, ponto-e-vírgula e espaço duplicado contam como UM separador", () => {
    expect(tokenizarTermoDeBusca("Silva,  João;;Jr")).toEqual(["Silva", "João", "Jr"]);
  });
  it("termo de uma palavra só continua sendo um token só", () => {
    expect(tokenizarTermoDeBusca("Maria")).toEqual(["Maria"]);
  });
  it("termo só de separadores vira lista vazia, não token vazio", () => {
    expect(tokenizarTermoDeBusca(",,,   ;")).toEqual([]);
  });
});

describe("busca do inbox — todos os tokens precisam bater, não a frase inteira", () => {
  it('⭐ "Paulo Jr" acha via and(display_name...) com os DOIS tokens, não a frase contígua', async () => {
    const c = await buscar("Paulo Jr", [{ id: "contato-paulo" }]);
    const grupo = args(c, "contacts", "or");
    // O grupo tem que exigir os dois tokens no MESMO campo — "and(" é a
    // gramática que expressa isso; a frase "Paulo Jr" inteira não pode
    // aparecer sozinha (isso seria o defeito antigo, contíguo).
    expect(grupo).toContain("and(display_name.ilike.*Paulo*,display_name.ilike.*Jr*)");
    expect(grupo).toContain("and(name.ilike.*Paulo*,name.ilike.*Jr*)");
  });

  it("termo com vírgula solta (separador duplicado) tokeniza em vez de quebrar a sintaxe", async () => {
    const c = await buscar("Silva,, João", [{ id: "contato-silva" }]);
    const grupo = args(c, "contacts", "or");
    expect(grupo).toContain("and(display_name.ilike.*Silva*,display_name.ilike.*João*)");
  });

  it("busca por conteúdo (sem contato casado) também exige todos os tokens — encadeando ilike", async () => {
    const c = await buscar("prazo entrega", []);
    const chamadasDeIlike = c.filter(
      (x) => x.tabela === "conversations" && x.metodo === "ilike",
    );
    expect(chamadasDeIlike.map((x) => x.args.join("|"))).toEqual([
      "last_message_preview|%prazo%",
      "last_message_preview|%entrega%",
    ]);
  });

  it("termo só de separadores (\",,,\") não quebra a busca — se comporta como sem termo nenhum", async () => {
    const { client, chamadas } = fakeSupabase([]);
    await listConversationsHandler(client, ctx, { limit: 50, search: ",,, " } as never);
    expect(
      chamadas.filter((x) => x.tabela === "contacts"),
      "tokenizou pra lista vazia e ainda assim consultou contacts",
    ).toEqual([]);
  });
});

describe("a tela promete o que a busca entrega", () => {
  it("o campo não diz mais 'Buscar mensagens'", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const fonte = readFileSync(
      join(process.cwd(), "components/inbox/InboxFilters.tsx"),
      "utf8",
    );
    // Controle positivo: a sonda tem de achar o placeholder onde ele está.
    expect(fonte).toContain("placeholder=");
    expect(
      /Buscar mensagens/.test(fonte),
      "o campo promete só mensagens enquanto a busca já cobre nome e telefone",
    ).toBe(false);
  });
});
