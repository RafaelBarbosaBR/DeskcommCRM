import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * O bloco SÓ-LEITURA do item 4b do pedido: o que o tracker automático do
 * site capturou de verdade pra este contato, lendo `touchpoints`
 * (`lib/rastreamento/captura/`). Nunca escreve nada — é projeção pura.
 *
 * Quando não há nenhuma linha (cadastro manual, contato nunca passou pelo
 * tracker.js), `semTracking: true` — a tela precisa dizer isso explicitamente
 * em vez de mostrar campos vazios que pareceriam "sem dado ainda", que é uma
 * afirmação diferente de "nunca existiu".
 */
export interface ToquePosicionado {
  occurredAt: string;
  url: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  fbclid: string | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
}

export type AtribuicaoDeRastreamento =
  | { semTracking: true }
  | {
      semTracking: false;
      primeiroToque: ToquePosicionado;
      ultimoToque: ToquePosicionado;
      historico: ToquePosicionado[];
    };

const COLS =
  "occurred_at, url, utm_source, utm_medium, utm_campaign, utm_term, utm_content, fbclid, gclid, gbraid, wbraid";

function paraToque(linha: Record<string, unknown>): ToquePosicionado {
  return {
    occurredAt: linha.occurred_at as string,
    url: (linha.url as string | null) ?? null,
    utmSource: (linha.utm_source as string | null) ?? null,
    utmMedium: (linha.utm_medium as string | null) ?? null,
    utmCampaign: (linha.utm_campaign as string | null) ?? null,
    utmTerm: (linha.utm_term as string | null) ?? null,
    utmContent: (linha.utm_content as string | null) ?? null,
    fbclid: (linha.fbclid as string | null) ?? null,
    gclid: (linha.gclid as string | null) ?? null,
    gbraid: (linha.gbraid as string | null) ?? null,
    wbraid: (linha.wbraid as string | null) ?? null,
  };
}

export async function lerAtribuicaoDoContato(
  admin: SupabaseClient,
  contactId: string | null,
): Promise<AtribuicaoDeRastreamento> {
  if (!contactId) return { semTracking: true };

  const { data } = await admin
    .from("touchpoints")
    .select(COLS)
    .eq("contact_id", contactId)
    .order("occurred_at", { ascending: true })
    .limit(200);

  const linhas = (data ?? []) as unknown as Record<string, unknown>[];
  if (linhas.length === 0) return { semTracking: true };

  const historico = linhas.map(paraToque);
  return {
    semTracking: false,
    primeiroToque: historico[0]!,
    ultimoToque: historico[historico.length - 1]!,
    historico,
  };
}
