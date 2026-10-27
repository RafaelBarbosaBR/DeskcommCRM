/**
 * A RECUSA DA MÍDIA FORA DA JANELA DE 24 HORAS, no caminho que envia por
 * `sendMessageHandler` (automação e o atalho inline do follow-up).
 *
 * ═══ O que ela protege ═══
 *
 * Mídia com legenda é mensagem LIVRE (free-form): não é modelo aprovado. Em canal
 * de hetero-restrição — a API oficial da Meta e os parceiros que a espelham — a
 * plataforma recusa a ENTREGA fora da janela de 24h (131047), mesmo quando o envio
 * responde 200. O passo automático que ignorasse isso "enviaria" e o cliente não
 * receberia nada.
 *
 * O desfecho é decisão deste PR (a #2734 pede só "respeitar as regras de modelo
 * aprovado"): se a mídia não pode sair, RECUSE com motivo explícito — e NUNCA mande
 * o texto solto no lugar. Mandar só a legenda como texto é pior que não mandar: o
 * cliente recebe uma frase sobre uma imagem que não veio.
 *
 * ═══ Por que a régua não é reescrita aqui ═══
 *
 * Quem decide "esta janela está fechada" é `canalAceitaTextoLivreAgora`
 * (`lib/channels/janela.ts`), alimentada pela matriz de capabilities
 * (`lib/channels/capabilities.ts`). É o MESMO veredito que o cron de lembrete de
 * agenda passou a usar contra o mesmo engano de 131047; uma segunda cópia da
 * regra aqui reintroduziria a divergência que aquele arquivo existe para acabar —
 * e é por isso que este módulo vive FORA de `lib/channels/`.
 *
 * Canal que a matriz não conhece (ou cujo provider não pôde ser lido) responde
 * "não está fechada" — a mesma direção conservadora-aditiva de
 * `canalAceitaTextoLivreAgora`: barrar por uma regra que não existe puniria um
 * canal que talvez envie (um transporte de QR, por exemplo).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { canalAceitaTextoLivreAgora } from "@/lib/channels/janela";

/**
 * Motivo da recusa, ou `null` quando a mídia pode sair agora.
 *
 * `provider` e `last_inbound_at` vêm do BANCO e não de um palpite: a sessão do
 * canal e a conversa da fronteira. Ler a conversa errada (outro número do mesmo
 * contato) decidiria pela janela de uma conversa que não é esta.
 */
export async function recusaDeMidiaForaDaJanela(
  admin: SupabaseClient,
  input: { organizationId: string; conversationId: string; agora: Date },
): Promise<string | null> {
  const { data: conversa, error: erroDaConversa } = await admin
    .from("conversations")
    .select("last_inbound_at, channel_session_id")
    .eq("id", input.conversationId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  // Erro de leitura: falha ABERTA. Não saber o canal não é prova de que ele
  // restringe; a mídia segue pela mesma direção de `canalAceitaTextoLivreAgora`.
  if (erroDaConversa) return null;

  const sessionId = (conversa?.channel_session_id as string | null | undefined) ?? null;
  let provider: string | null = null;
  if (sessionId) {
    const { data: sessao, error: erroDaSessao } = await admin
      .from("channel_sessions")
      .select("provider")
      .eq("id", sessionId)
      .eq("organization_id", input.organizationId)
      .maybeSingle();
    if (erroDaSessao) return null;
    provider = (sessao?.provider as string | null | undefined) ?? null;
  }

  const ultimoInbound = (conversa?.last_inbound_at as string | null | undefined) ?? null;

  if (canalAceitaTextoLivreAgora(provider, ultimoInbound, input.agora)) return null;
  return "A janela de 24 horas deste canal está fechada: fora dela só um modelo aprovado pode sair, e mídia com legenda é mensagem livre. A mídia não foi enviada, e o texto não saiu sozinho.";
}
