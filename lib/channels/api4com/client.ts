/**
 * Cliente REST da api4com (telefonia/voz) — developers.api4com.com.
 *
 * ═══ Base da API, sobrescrevível ═══
 *
 * `||` e não `??`, com `.trim()` — mesma régua de `lib/channels/zernio/
 * credentials.ts` (`zernioBaseUrl`): `.env.example` entrega a chave VAZIA, e
 * `??` deixaria a string vazia passar como "valor presente", quebrando todo
 * fetch com `Failed to parse URL`.
 *
 * ═══ Token nunca é a senha ═══
 *
 * `login()` troca e-mail+senha por um token de 14 dias; `mintPermanentToken()`
 * usa ESSE token pra criar um segundo token com `ttl: -1` (nunca expira) — é o
 * que fica gravado (cifrado) em `api4com_connections`. A senha da conta nunca
 * é persistida, nem de passagem: `connect.ts` (server action, fora deste
 * arquivo) descarta as duas variáveis assim que `mintPermanentToken` retorna.
 *
 * ═══ Erros ═══
 *
 * A doc pública lista 404 (`EXTENSION_NOT_FOUND`), 422 (parâmetro inválido),
 * 424 (não deu pra estabelecer a chamada) e 429 (rate limit — 15 req/min por
 * ramal) para `POST /calls`. `Api4comError` carrega o status pra quem chama
 * decidir a mensagem (ex.: 404 vira "ramal não encontrado", não erro genérico).
 */
export class Api4comError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "Api4comError";
  }
}

export function api4comBaseUrl(): string {
  return process.env.API4COM_API_BASE_URL?.trim() || "https://api.api4com.com/api/v1";
}

export interface Api4comLoginResult {
  token: string;
  ttl: number;
}

export interface Api4comExtension {
  id: string;
  extension: string;
  name?: string;
}

export interface Api4comClickToCallResult {
  id: string;
}

async function req<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, ...rest } = init;
  const res = await fetch(`${api4comBaseUrl()}${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: token } : {}),
      ...rest.headers,
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Api4comError(res.status, `api4com_${res.status}: ${body.slice(0, 300)}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** `POST /users/login` — a ÚNICA chamada que vê a senha, e não a guarda. */
export async function api4comLogin(email: string, password: string): Promise<Api4comLoginResult> {
  const data = await req<{ id: string; ttl: number }>("/users/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  return { token: data.id, ttl: data.ttl };
}

/** `GET /users/me` — só pra exibir "conectado como X" na tela de conexão. */
export async function api4comWhoAmI(loginToken: string): Promise<{ email: string }> {
  return req<{ email: string }>("/users/me", { token: loginToken });
}

/**
 * `POST /users/accessTokens` com `ttl: -1` — token que NUNCA expira. É o que
 * `api4com_connections.access_token_encrypted` guarda; o token de login (14
 * dias) é descartado depois desta chamada.
 */
export async function api4comMintPermanentToken(loginToken: string): Promise<string> {
  const data = await req<{ id: string }>("/users/accessTokens", {
    method: "POST",
    token: loginToken,
    body: JSON.stringify({ ttl: -1 }),
  });
  return data.id;
}

/** `GET /extensions` — ramais já existentes na conta, pro admin mapear por usuário. */
export async function api4comListExtensions(accessToken: string): Promise<Api4comExtension[]> {
  const data = await req<{ data: Api4comExtension[] }>("/extensions?page=1", { token: accessToken });
  return data.data ?? [];
}

/**
 * `PATCH /integrations` — registra/atualiza o webhook que a nossa rota
 * recebe. `gateway` é o identificador fixo desta integração no lado deles;
 * reusar o MESMO em toda chamada faz o PATCH atualizar em vez de duplicar.
 */
export async function api4comUpsertWebhook(accessToken: string, webhookUrl: string): Promise<void> {
  await req("/integrations", {
    method: "PATCH",
    token: accessToken,
    body: JSON.stringify({
      gateway: "deskcomm-crm",
      webhook: true,
      metadata: {
        webhookUrl,
        webhookVersion: "1.8",
        webhookTypes: ["channel-answer", "channel-hangup"],
      },
    }),
  });
}

export interface Api4comClickToCallInput {
  extension: string;
  caller: string;
  called: string;
  metadata?: Record<string, unknown>;
}

/**
 * `POST /calls` — origina a chamada. A resposta só chega quando o RAMAL
 * atende (toca até lá); quem chama precisa de timeout HTTP generoso — mesmo
 * aviso da doc pública.
 */
export async function api4comClickToCall(
  accessToken: string,
  input: Api4comClickToCallInput,
): Promise<Api4comClickToCallResult> {
  return req<Api4comClickToCallResult>("/calls", {
    method: "POST",
    token: accessToken,
    body: JSON.stringify({
      extension: input.extension,
      caller: input.caller,
      called: input.called,
      metadata: input.metadata ?? {},
    }),
  });
}
