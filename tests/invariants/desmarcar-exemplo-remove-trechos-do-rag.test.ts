import { beforeAll, describe, expect, it } from "vitest";

import { GOV_CONV_AGENT_B, GOV_CONV_UNASSIGNED, GOV_ORG, seedGov, sql } from "./gov-helpers";

/**
 * DESMARCAR O EXEMPLO TIRA OS TRECHOS JÁ APRENDIDOS DO RAG (#3042, migration 0688).
 *
 * Desmarcar `usable_for_rag` só impedia as ingestões FUTURAS. Os `ai_chunks`
 * já gravados da conversa seguiam alcançáveis por `retrieve_top_k_chunks`.
 *
 * O que este arquivo prova, contra o Postgres do baseline:
 *  1. o trecho da conversa desmarcada é alcançável antes e sai depois; o da
 *     conversa vizinha, na mesma fonte e organização, fica;
 *  2. a conversa precisa ser da organização passada: chamar com o id de uma
 *     conversa que não é dela não apaga nada, nem o trecho que a cita;
 *  3. a contagem real volta e a segunda chamada devolve 0 (idempotente).
 *
 * ─── SABOTAGEM (linha para reverter: migration 0688) ────────────────────────
 * - Tirar `metadata->>'conversation_id'` do `delete`: cai o caso 1 (leva a
 *   conversa vizinha).
 * - Tirar o `exists` em `conversations`: cai o caso 2.
 * - Devolver 0 fixo em vez de `row_count`: cai o caso 1 (a contagem).
 */

const VETOR = `(select array_fill(0.1::real, array[1536])::vector)`;

const AGENTE = "dddd3042-1111-4000-8000-000000000001";
const FONTE = "dddd3042-3333-4000-8000-000000000001";
const VERSAO = "dddd3042-2222-4000-8000-000000000001";
/** Conversa que não existe em `conversations`, só no metadata de um trecho. */
const CONV_ALHEIA = "dddd3042-4444-4000-8000-000000000001";

function trechos(): string[] {
  return sql(
    `select content from public.retrieve_top_k_chunks('${GOV_ORG}', '${VERSAO}', ${VETOR}, 10, -1) order by content;`,
  )
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

const remove = (conversa: string) =>
  sql(`select public.fn_conversa_remove_trechos_do_rag('${GOV_ORG}', '${conversa}');`).trim();

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.ai_agents (id, organization_id, name, system_prompt, kind, is_default)
      values ('${AGENTE}', '${GOV_ORG}', 'Agente do RAG 3042', 'p', 'mcp_agent', false)
      on conflict do nothing;
    insert into public.ai_knowledge_sources
      (id, organization_id, agent_id, source_type, name, status, is_active)
      values ('${FONTE}', '${GOV_ORG}', null, 'documento', 'Conversas (prova 3042)', 'ready', true)
      on conflict do nothing;
    insert into public.ai_knowledge_versions
      (id, organization_id, agent_id, knowledge_source_id, version_number, status, is_active)
      values ('${VERSAO}', '${GOV_ORG}', '${AGENTE}', null, 1, 'ready', true)
      on conflict do nothing;
    insert into public.ai_chunks
      (organization_id, knowledge_source_id, kb_version_id, position, content, content_hash, token_count, embedding, metadata)
      values
        ('${GOV_ORG}', '${FONTE}', '${VERSAO}', 0, 'trecho A da conversa desmarcada', 'h-3042-a', 8, ${VETOR},
         jsonb_build_object('source_type', 'conversas', 'conversation_id', '${GOV_CONV_UNASSIGNED}')),
        ('${GOV_ORG}', '${FONTE}', '${VERSAO}', 1, 'trecho B da conversa desmarcada', 'h-3042-b', 8, ${VETOR},
         jsonb_build_object('source_type', 'conversas', 'conversation_id', '${GOV_CONV_UNASSIGNED}')),
        ('${GOV_ORG}', '${FONTE}', '${VERSAO}', 2, 'trecho da conversa vizinha', 'h-3042-c', 8, ${VETOR},
         jsonb_build_object('source_type', 'conversas', 'conversation_id', '${GOV_CONV_AGENT_B}')),
        ('${GOV_ORG}', '${FONTE}', '${VERSAO}', 3, 'trecho que cita conversa de fora', 'h-3042-d', 8, ${VETOR},
         jsonb_build_object('source_type', 'conversas', 'conversation_id', '${CONV_ALHEIA}'));
  `);
});

describe("desmarcar exemplo: trechos já aprendidos saem do RAG (#3042)", () => {
  it("conversa que não é da organização não apaga nada", () => {
    expect(remove(CONV_ALHEIA)).toBe("0");
    expect(trechos()).toContain("trecho que cita conversa de fora");
  });

  it("o trecho da conversa desmarcada sai de alcance; o da vizinha fica", () => {
    expect(trechos()).toEqual([
      "trecho A da conversa desmarcada",
      "trecho B da conversa desmarcada",
      "trecho da conversa vizinha",
      "trecho que cita conversa de fora",
    ]);
    expect(remove(GOV_CONV_UNASSIGNED)).toBe("2");
    expect(trechos()).toEqual(["trecho da conversa vizinha", "trecho que cita conversa de fora"]);
  });

  it("idempotente: a segunda chamada devolve 0", () => {
    expect(remove(GOV_CONV_UNASSIGNED)).toBe("0");
    expect(trechos()).toEqual(["trecho da conversa vizinha", "trecho que cita conversa de fora"]);
  });
});
