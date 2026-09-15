/**
 * Cliente REST/SSE do servidor WaCalls (Go + whatsmeow + pion/webrtc,
 * terceiro MIT — ver o cabeçalho de `Dockerfile.wacalls` para commit
 * vendorizado). Devolve `null` de `getWacallsClient()` quando o env não está
 * configurado, mesmo padrão de `lib/waha/client.ts`'s `getWahaClient()`.
 *
 * ═══ CONTRATO VERIFICADO, NÃO CHUTADO ═══
 *
 * Ao contrário do resto desta entrega (código novo sem como testar contra o
 * real), este arquivo foi escrito lendo a FONTE do servidor de terceiro
 * (`cmd/server/httpapi.go`, `session.go`, `sessionmanager.go`, `broker.go`
 * no commit vendorizado) e CONFIRMADO rodando a imagem `Dockerfile.wacalls`
 * de verdade nesta máquina: `go build` passou, o contêiner subiu,
 * `GET /api/sessions` respondeu, `POST /api/sessions` pareou e emitiu QR via
 * SSE. As formas de rota/corpo/evento abaixo são as REAIS, não uma suposição
 * da spec.
 *
 * ═══ SEM AUTENTICAÇÃO — de propósito, não descuido ═══
 *
 * A API do WaCalls não tem nenhuma (confirmado na fonte: nenhum middleware de
 * auth, `withCORS` é tudo que existe). O README deles admite isso na cara:
 * "run it only on a trusted LAN". A segurança AQUI é de REDE — o serviço
 * entra só em `internal`, sem `ports:` publicado (ver docker-compose.prod.yml)
 * —, não de credencial que este cliente teria que mandar.
 *
 * `X-Client-Id` (o parâmetro `clientId` dos métodos de chamada) NÃO é
 * autenticação: é como o servidor decide "de quem é esta ligação" para as
 * checagens de conflito (`operator already on a call`). Mandamos o
 * `user.id` do nosso app ali — identifica o ATENDENTE, não autentica nada.
 */
import { classificarFalhaDeAlcance, explicarFalhaDeAlcance } from "@/lib/net/alcance";

export const TETO_PADRAO_MS = 15_000;

export interface WacallsClientOpts {
  tetoMs?: number;
}

export type WacallsAuthState = "connecting" | "qr" | "open" | "logged_out";

export interface WacallsSessionInfo {
  id: string;
  name: string;
  jid: string;
  state: WacallsAuthState;
  paired: boolean;
}

export type WacallsCallStatus = "starting" | "ringing" | "connected" | "ended";

export interface WacallsCallRecord {
  sessionId: string;
  callId: string;
  owner: string | null;
  direction: "inbound" | "outbound";
  peer: string;
  startedAt: number;
  status: WacallsCallStatus;
  endedAt?: number | null;
  endReason?: string;
}

export class WacallsError extends Error {
  constructor(
    public readonly operation: string,
    public readonly httpStatus: number,
  ) {
    super(`wacalls_${operation}_${httpStatus}`);
    this.name = "WacallsError";
  }
}

export class WacallsClient {
  private readonly tetoMs: number;

  constructor(
    private readonly baseUrl: string,
    opts: WacallsClientOpts = {},
  ) {
    this.tetoMs = opts.tetoMs ?? TETO_PADRAO_MS;
  }

  private async fetchComTeto(path: string, init: RequestInit = {}, tetoMs?: number): Promise<Response> {
    const teto = tetoMs ?? this.tetoMs;
    const url = `${this.baseUrl}${path}`;
    try {
      return await fetch(url, {
        ...init,
        headers: { "Content-Type": "application/json", ...init.headers },
        signal: AbortSignal.timeout(teto),
      });
    } catch (e) {
      const nome = e instanceof Error ? e.name : "";
      if (nome === "TimeoutError" || nome === "AbortError") {
        throw new Error(`wacalls_timeout: o WaCalls não respondeu em ${teto}ms (${url})`);
      }
      throw e;
    }
  }

  async listSessions(): Promise<WacallsSessionInfo[]> {
    const res = await this.fetchComTeto("/api/sessions");
    if (!res.ok) throw new WacallsError("list_sessions", res.status);
    const body = (await res.json()) as { sessions: WacallsSessionInfo[] };
    return body.sessions;
  }

  /** Cria uma conta nova E já dispara o pareamento por QR (o próprio servidor faz os dois). */
  async createSession(name: string): Promise<{ id: string }> {
    const res = await this.fetchComTeto("/api/sessions", { method: "POST", body: JSON.stringify({ name }) });
    if (!res.ok) throw new WacallsError("create_session", res.status);
    return (await res.json()) as { id: string };
  }

  /** Desloga E remove a conta — credenciais apagadas do lado do servidor. */
  async deleteSession(sid: string): Promise<void> {
    const res = await this.fetchComTeto(`/api/sessions/${encodeURIComponent(sid)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new WacallsError("delete_session", res.status);
  }

  /** Desconecta mas MANTÉM a conta para reparear depois (`pairSession`). */
  async logoutSession(sid: string): Promise<void> {
    const res = await this.fetchComTeto(`/api/sessions/${encodeURIComponent(sid)}/logout`, { method: "POST" });
    if (!res.ok && res.status !== 404) throw new WacallsError("logout_session", res.status);
  }

  /** Reemite QR para uma sessão já existente. Erro 400 se ela já está pareada. */
  async pairSession(sid: string): Promise<void> {
    const res = await this.fetchComTeto(`/api/sessions/${encodeURIComponent(sid)}/pair`, { method: "POST" });
    if (!res.ok) throw new WacallsError("pair_session", res.status);
  }

  /** Disca. `phone` com ou sem `+`, dígitos puros por dentro (o servidor normaliza). */
  async placeCall(sid: string, phone: string, clientId: string): Promise<{ callId: string }> {
    const res = await this.fetchComTeto(`/api/sessions/${encodeURIComponent(sid)}/calls`, {
      method: "POST",
      headers: { "X-Client-Id": clientId },
      body: JSON.stringify({ phone }),
    });
    if (!res.ok) throw new WacallsError("place_call", res.status);
    const body = (await res.json()) as { call: { callId: string } };
    return body.call;
  }

  async acceptCall(sid: string, callId: string, clientId: string): Promise<{ callId: string }> {
    const res = await this.fetchComTeto(
      `/api/sessions/${encodeURIComponent(sid)}/calls/${encodeURIComponent(callId)}/accept`,
      { method: "POST", headers: { "X-Client-Id": clientId } },
    );
    if (!res.ok) throw new WacallsError("accept_call", res.status);
    const body = (await res.json()) as { call: { callId: string } };
    return body.call;
  }

  async rejectCall(sid: string, callId: string): Promise<void> {
    const res = await this.fetchComTeto(
      `/api/sessions/${encodeURIComponent(sid)}/calls/${encodeURIComponent(callId)}/reject`,
      { method: "POST" },
    );
    if (!res.ok) throw new WacallsError("reject_call", res.status);
  }

  async endCall(sid: string, callId: string): Promise<void> {
    const res = await this.fetchComTeto(
      `/api/sessions/${encodeURIComponent(sid)}/calls/${encodeURIComponent(callId)}`,
      { method: "DELETE" },
    );
    if (!res.ok && res.status !== 404) throw new WacallsError("end_call", res.status);
  }

  /**
   * SDP offer do browser → SDP answer do servidor (pion). Campos em
   * snake_case porque é literalmente o JSON que o Go decodifica
   * (`sdp_offer`/`sdp_answer`) — não um capricho nosso.
   */
  async relayWebrtcSignal(sid: string, callId: string, sdpOffer: string): Promise<{ sdpAnswer: string }> {
    const res = await this.fetchComTeto(
      `/api/sessions/${encodeURIComponent(sid)}/calls/${encodeURIComponent(callId)}/webrtc`,
      { method: "POST", body: JSON.stringify({ sdp_offer: sdpOffer }) },
    );
    if (!res.ok) throw new WacallsError("webrtc_signal", res.status);
    const body = (await res.json()) as { sdp_answer: string };
    return { sdpAnswer: body.sdp_answer };
  }

  /** Até 50 registros — teto do próprio servidor (`historyRows(sess.id, 50)`), não nosso. */
  async history(sid: string): Promise<WacallsCallRecord[]> {
    const res = await this.fetchComTeto(`/api/sessions/${encodeURIComponent(sid)}/history`);
    if (!res.ok) throw new WacallsError("history", res.status);
    const body = (await res.json()) as { rows: WacallsCallRecord[] };
    return body.rows;
  }

  /**
   * O stream SSE inteiro do servidor (`GET /api/events`) — GLOBAL, não por
   * sessão: eventos de TODAS as contas pareadas neste servidor chegam aqui,
   * com `sessionId` dentro de cada um para quem consome filtrar. Devolve um
   * async generator que produz um objeto por frame `data: {...}\n\n`;
   * encerra sozinho quando `signal` aborta ou a conexão cai (quem chama
   * decide se reconecta — ver `events-bridge.ts`).
   *
   * NÃO usa `fetchComTeto`: esta conexão fica aberta por design (o servidor
   * manda um `: ping` a cada 20s só para o proxy não fechar por
   * inatividade) — um teto de 15s a derrubaria a cada ciclo.
   */
  async *streamEvents(signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/api/events`, { signal, headers: { Accept: "text/event-stream" } });
    if (!res.ok || !res.body) throw new WacallsError("stream_events", res.status);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        // Frames SSE são separados por linha em branco dupla (`\n\n`).
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const linhaDeDados = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!linhaDeDados) continue; // comentário `: ping` ou frame vazio
          try {
            yield JSON.parse(linhaDeDados.slice("data: ".length)) as Record<string, unknown>;
          } catch {
            // Frame malformado — não derruba o stream inteiro por um evento ruim.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/** Mesmo raciocínio de `wahaFriendlyError`: nunca propaga o corpo cru do terceiro. */
export function wacallsFriendlyError(erro: unknown): string {
  const falha = classificarFalhaDeAlcance(erro);
  if (falha !== "indeterminada") {
    return explicarFalhaDeAlcance(falha, "o serviço de chamada de voz (WaCalls)");
  }
  const msg = erro instanceof Error ? erro.message : String(erro ?? "unknown");
  return `Falha na comunicação com o serviço de chamada de voz (WaCalls): ${msg}`;
}

/**
 * `null` = feature nem existe nesta instalação (`WACALLS_API_BASE_URL`
 * ausente) — o chamador decide entre esconder a UI ou mostrar "recurso não
 * instalado", nunca estourar. Espelha `getWahaClient()`.
 */
export function getWacallsClient(): WacallsClient | null {
  const url = process.env.WACALLS_API_BASE_URL;
  if (!url) return null;
  return new WacallsClient(url);
}
