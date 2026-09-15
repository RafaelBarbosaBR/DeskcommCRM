import { describe, expect, it } from "vitest";

import { createContactHandler } from "@/app/api/v1/contacts/_handler";
import type { ContactCreate } from "@/lib/schemas";
import type { HandlerCtx } from "@/lib/api/handlers/types";

/**
 * TELEFONE DUPLICADO DEVOLVE 409, NÃO 500 GENÉRICO.
 *
 * Achado no changelog do upstream: criar um contato com telefone já
 * cadastrado (índice `uniq_contacts_org_phone`) estourava a unique constraint
 * do Postgres (`23505`) direto pro 500 genérico — sem dizer QUAL contato já
 * tinha aquele telefone, então quem chamava não tinha como oferecer "editar o
 * existente" em vez de tentar de novo contra a mesma parede.
 */

type Chamada = { tabela: string; metodo: string; args: unknown[] };

function fakeSupabase(opts: { insertErrorCode: string | null; contatoExistenteId: string | null }) {
  const chamadas: Chamada[] = [];
  const client = {
    from: (tabela: string) => {
      if (tabela !== "contacts") throw new Error(`tabela inesperada: ${tabela}`);
      return {
        insert: (row: unknown) => {
          chamadas.push({ tabela, metodo: "insert", args: [row] });
          return {
            select: () => ({
              single: async () =>
                opts.insertErrorCode
                  ? { data: null, error: { code: opts.insertErrorCode, message: "duplicate key value" } }
                  : { data: { id: "contact-novo", organization_id: "org-1" }, error: null },
            }),
          };
        },
        select: (cols: string) => {
          chamadas.push({ tabela, metodo: "select", args: [cols] });
          return {
            eq: () => ({
              eq: () => ({
                maybeSingle: async () =>
                  opts.contatoExistenteId
                    ? { data: { id: opts.contatoExistenteId }, error: null }
                    : { data: null, error: null },
              }),
            }),
          };
        },
      };
    },
  };
  return { client: client as never, chamadas };
}

const ctx: HandlerCtx = {
  organization_id: "org-1",
  requestId: "req-1",
  actor: { type: "user", id: "user-1" },
  idioma: "pt-BR",
};

const INPUT: ContactCreate = {
  phone_number: "+5511999998888",
  source: "manual",
} as ContactCreate;

describe("criar contato com telefone duplicado", () => {
  it("devolve ApiError 409 contact_exists com o id do contato já existente", async () => {
    const { client } = fakeSupabase({ insertErrorCode: "23505", contatoExistenteId: "contact-antigo" });

    await expect(createContactHandler(client, ctx, INPUT)).rejects.toMatchObject({
      status: 409,
      code: "contact_exists",
      details: { contact_id: "contact-antigo" },
    });
  });

  it("outro erro de banco continua 500 internal_error (não veste a roupa do 409)", async () => {
    const { client } = fakeSupabase({ insertErrorCode: "23503", contatoExistenteId: null });

    await expect(createContactHandler(client, ctx, INPUT)).rejects.toMatchObject({
      status: 500,
      code: "internal_error",
    });
  });

});
