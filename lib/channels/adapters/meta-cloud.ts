/**
 * Adapter da WhatsApp Cloud API — o transporte do canal oficial.
 *
 * Burro de propósito, como o irmão não-oficial: traduz formato e nada mais. Se
 * aparecer aqui um `if` sobre janela de 24h, cap diário ou horário, o desenho vazou —
 * essas regras vivem na cadeia `before_send` (doutrina `restricao-de-canal.md`).
 *
 * ─── Três diferenças que mordem quem copia o adapter do outro canal ──────────
 *
 * 1. **Não existe "sessão".** O outro canal endereça por `sessionRef` (um nome de
 *    sessão); aqui o `sessionRef` é o `phone_number_id`, e ele entra na URL, não no
 *    corpo. Mandar no corpo devolve 400 sem explicar.
 *
 * 2. **Destinatário é E.164 em DÍGITOS, sem `+` e sem sufixo.** Nada de `@c.us`. Um
 *    `+` sobrevivente vira `(#131009) Parameter value is not valid`.
 *
 * 3. **Áudio vira nota de voz só com `voice: true`.** Medido na doc oficial: sem a
 *    flag, um `.ogg/opus` chega como anexo de música, com ícone de nota musical em vez
 *    da bolha de voz. E a Meta **não converte** — quem manda mp3 com `voice:true` erra;
 *    o outro canal converte por nós, este não.
 */
import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { MAX_MEDIA_BYTES, MediaTooLargeError, type FetchedMedia } from "@/lib/messaging/media/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { metaContactsPayload } from "@/lib/channels/meta/contact-card";
import { resolveMetaCreds } from "../meta/credentials";
import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelTenantScope,
  OutboundEnvelope,
  RecipientInput,
} from "../types";

/** Só dígitos. `+55 (31) 99896-6398` → `5531998966398`. */
function toE164Digits(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * Credencial do ambiente — o caminho de instalação de número único.
 *
 * `isConfigured()` continua olhando só o env de propósito: ele responde "dá para
 * tentar?" de forma SÍNCRONA, e a resposta certa para uma instalação que gravou a
 * credencial na sessão vem do banco. Quem sabe disso é o `send`, que é async.
 * Devolver `false` aqui com sessão configurada faria o handler gravar `queued` sem
 * motivo — por isso o `send` resolve de novo, com a sessão, antes de desistir.
 */
import { metaCredsFromEnv } from "../meta/credentials";
export { metaCredsFromEnv as getMetaCreds };

/** `kind: "contact"` → objeto `contacts` da Cloud API. */
function contactPayload(env: OutboundEnvelope): Record<string, unknown> | null {
  if (env.kind !== "contact" || !env.contact) return null;
  return {
    type: "contacts",
    contacts: metaContactsPayload(env.contact.fullName, env.contact.phoneNumber),
  };
}

/** `kind` do envelope → objeto de mídia da Cloud API. */
function mediaPayload(env: OutboundEnvelope): Record<string, unknown> | null {
  if (!env.media) return null;
  const link = env.media.url;
  const caption = env.media.caption ?? undefined;

  switch (env.kind) {
    case "image":
      return { type: "image", image: { link, ...(caption ? { caption } : {}) } };
    case "video":
      return { type: "video", video: { link, ...(caption ? { caption } : {}) } };
    case "audio":
      // `voice: true` é o que faz virar BOLHA DE VOZ. Sem ele, anexo de música.
      // Exige ogg/opus — a Meta não converte, diferente do outro canal.
      return { type: "audio", audio: { link, voice: true } };
    default:
      return {
        type: "document",
        document: {
          link,
          ...(env.media.filename ? { filename: env.media.filename } : {}),
          ...(caption ? { caption } : {}),
        },
      };
  }
}

export const metaCloudAdapter: ChannelAdapter = {
  provider: "meta_cloud",

  resolveRecipient(input: RecipientInput): string | null {
    // Grupos: a API de grupos da Cloud é recente e não faz parte deste seam ainda.
    // Devolver null é honesto — o chamador grava `missing_phone_number` em vez de
    // montar um endereço que a Meta recusaria.
    if (input.isGroup) return null;
    if (!input.phoneNumber) return null;
    const digits = toE164Digits(input.phoneNumber);
    return digits.length > 0 ? digits : null;
  },

  /**
   * DÍVIDA CONHECIDA, deixada de propósito — não é descuido.
   *
   * A credencial deste canal também pode viver na SESSÃO (a tela de "Conectar
   * canal oficial" grava `meta_token_encrypted` desde a 0118), e `isConfigured`
   * é síncrono: não consulta o banco. Numa instalação que conectou pela tela e
   * não escreveu `.env`, isto devolve `false`, e o handler (`_handler.ts:370`)
   * grava `queued` com `queued_reason: meta_not_configured` sem nunca chamar
   * `send` — mensagem parada no inbox, sem erro, com o canal conectado.
   *
   * O canal intermediado JÁ passou por isso e resolveu devolvendo `true` e
   * fazendo o `send` lançar (ver `adapters/zernio.ts`). O mesmo conserto cabe
   * aqui, mas ele muda um contrato com dois testes explícitos
   * (`tests/unit/channel-adapter-meta.test.ts`) cuja justificativa escrita é
   * "mesmo contrato do outro canal" — justificativa que o fork já não sustenta.
   *
   * Trocar contrato testado exige uma mudança própria, com os testes revistos de
   * propósito e não de passagem. Fica registrado aqui para quem for fazê-la.
   */
  isConfigured(): boolean {
    // Síncrono por contrato. Com credencial na sessão, quem confirma é o `send`
    // (async) — ver o comentário acima.
    return metaCredsFromEnv() !== null;
  },

  /**
   * Pergunta à plataforma se o número ainda responde.
   *
   * Sem este método o cron de saúde PULAVA a sessão (`if (!adapter.checkHealth)
   * continue`), sem log e sem contador: token vencido, número suspenso ou
   * permissão removida viravam silêncio absoluto com a tela dizendo
   * "conectado". E este canal não tem sequer o empurrão que o intermediado tem
   * — `lib/channels/meta/webhook.ts` só trata `messages` e status de template,
   * não `account_update` nem `phone_number_quality_update`.
   *
   * Reusa a MESMA chamada da validação de credencial: `GET /{phone_number_id}`.
   * O `sessionRef` deste canal É o `phone_number_id` (ver `resolveSessionRef`),
   * então ele já é a chave da consulta.
   *
   * `error` no corpo com HTTP 200 é comportamento real da Graph API, por isso a
   * checagem olha os dois. Erro de rede devolve `reachable: false` sem status:
   * uma oscilação virando "canal caído" ensinaria o operador a ignorar o aviso.
   */
  async checkHealth(
    input: ChannelTenantScope & { sessionRef: string },
  ): Promise<ChannelHealth> {
    const creds = await resolveMetaCreds(createAdminClient(), {
      organizationId: input.organizationId,
      phoneNumberId: input.sessionRef,
    });
    if (!creds) return { reachable: false, status: null, detail: "sem_credencial_para_a_sessao" };

    const version = process.env.META_GRAPH_VERSION ?? "v22.0";
    try {
      const res = await fetch(
        `https://graph.facebook.com/${version}/${input.sessionRef}?fields=display_phone_number,quality_rating`,
        {
          headers: { Authorization: `Bearer ${creds.token}` },
          // Teto de espera: um endpoint que pendura a conexão penduraria o cron
          // junto, e a varredura pararia para TODAS as sessões.
          signal: AbortSignal.timeout(15_000),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string; code?: number };
      };

      if (res.status === 401 || res.status === 403) {
        return { reachable: true, status: "FAILED", detail: null };
      }
      if (!res.ok || body.error) {
        // A Graph devolve 400 com `error.code` para token vencido — que é falha
        // de credencial, não indisponibilidade. Tratar como "não sei" deixaria
        // justamente a falha calada sem aviso.
        return { reachable: true, status: "FAILED", detail: (body.error?.message ?? "").slice(0, 200) || null };
      }
      return { reachable: true, status: "WORKING", detail: null };
    } catch (err) {
      const detail = err instanceof Error ? err.message : "erro_desconhecido";
      return { reachable: false, status: null, detail: detail.slice(0, 200) };
    }
  },

  codes: {
    notConfigured: "meta_not_configured",
    sendFailed: "meta_error",
    unknownError: "meta_unknown",
  },

  /**
   * Baixa o anexo que o cliente mandou.
   *
   * A Meta não manda URL nenhuma no webhook — só o `media.id` (ver
   * `lib/channels/meta/ingest.ts`, que grava esse id como `media_url` por não
   * ter outra coisa pra gravar). `input.url` aqui é ESSE id, não uma URL:
   * "cada canal sabe o que fazer com ela" é literal.
   *
   * O download é em DOIS passos, os dois autenticados com o MESMO Bearer:
   *
   *   1. `GET /{media-id}` devolve metadado — entre eles, a URL de verdade,
   *      assinada e de vida curta (documentado pela Meta como ~5 minutos).
   *      Não dá pra guardar essa URL: por isso o passo 2 acontece no mesmo
   *      request, nunca persistido entre um e outro.
   *   2. `GET` nessa URL, AINDA com o Bearer — sem ele a Meta devolve 401,
   *      diferente de um link público comum.
   *
   * A URL do passo 2 vem da PRÓPRIA Meta (resposta do passo 1 autenticado
   * contra `graph.facebook.com`), não do payload de um webhook — bem menos
   * exposta que o caso do canal intermediado (`zernio.ts`, onde a URL vem
   * direto do provider por fora). Mesmo assim passa pelas mesmas guardas de
   * SSRF que o resto do repo usa pra URL de fora: defesa em profundidade não
   * custa caro, e uma resposta inesperada não é motivo pra pular a checagem.
   */
  async fetchInboundMedia(input: ChannelTenantScope & {
    sessionRef: string;
    url: string;
    hintMime?: string | null;
  }): Promise<FetchedMedia> {
    const creds = await resolveMetaCreds(createAdminClient(), {
      organizationId: input.organizationId,
      phoneNumberId: input.sessionRef,
    });
    if (!creds) throw new Error("meta_not_configured: sem credencial para baixar a mídia.");

    const mediaId = input.url;
    const metaRes = await fetch(`https://graph.facebook.com/${creds.graphVersion}/${mediaId}`, {
      headers: { Authorization: `Bearer ${creds.token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const metaBody = (await metaRes.json().catch(() => ({}))) as {
      url?: string;
      mime_type?: string;
      file_size?: number;
      error?: { message?: string; code?: number };
    };
    if (!metaRes.ok || metaBody.error || !metaBody.url) {
      const detalhe = metaBody.error?.message ?? `http_${metaRes.status}`;
      throw new Error(`meta_media_lookup_failed: ${detalhe}`);
    }
    if (metaBody.file_size && metaBody.file_size > MAX_MEDIA_BYTES) throw new MediaTooLargeError();

    assertSafeOutboundUrl(metaBody.url);
    await assertDestinoResolvidoSeguro(new URL(metaBody.url).hostname);

    const res = await fetch(metaBody.url, {
      headers: { Authorization: `Bearer ${creds.token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`meta_media_download_failed: http_${res.status}`);

    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_MEDIA_BYTES) throw new MediaTooLargeError();

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_MEDIA_BYTES) throw new MediaTooLargeError();

    const mime =
      res.headers.get("content-type")?.split(";")[0]?.trim() ||
      metaBody.mime_type ||
      input.hintMime ||
      "application/octet-stream";
    return { buffer, mime };
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    // Sessão primeiro, env como fallback. O `sessionRef` do canal oficial É o
    // `phone_number_id` (ver `resolveSessionRef`), então ele é a chave da busca.
    const creds = await resolveMetaCreds(createAdminClient(), {
      organizationId: envelope.organizationId,
      phoneNumberId: envelope.sessionRef,
    });
    // Mesmo contrato do outro canal: sem credencial é NOOP, não exceção. A UI mostra
    // o banner de "canal não conectado"; transformar em erro mudaria comportamento.
    if (!creds) return { externalId: null };

    const corpo =
      contactPayload(envelope) ??
      mediaPayload(envelope) ??
      { type: "text", text: { body: envelope.body ?? "" } };

    await envelope.beforeSend?.();
    const res = await fetch(
      `https://graph.facebook.com/${creds.graphVersion}/${creds.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: envelope.to,
          ...corpo,
        }),
      },
    );

    const body = (await res.json().catch(() => ({}))) as {
      messages?: { id?: string }[];
      error?: { code?: number; message?: string; error_data?: { details?: string } };
    };

    if (!res.ok || body.error) {
      // `details` é o campo que diz QUAL parâmetro divergiu; sem ele o operador lê
      // "Parameter format does not match" e não tem pista nenhuma.
      const detalhe = body.error?.error_data?.details ?? body.error?.message ?? `http_${res.status}`;
      throw new Error(`meta_${body.error?.code ?? res.status}: ${detalhe}`);
    }

    return { externalId: body.messages?.[0]?.id ?? null };
  },
};
