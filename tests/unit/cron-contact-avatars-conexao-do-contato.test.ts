import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Defeito medido em produção (sem nome de cliente, sem número de PR):
 * o cron de fotos escolhia a primeira `channel_sessions` WORKING da empresa,
 * sem ordem e sem ligação com o contato. Com WhatsApp E Instagram/Facebook
 * ligados, às vezes devolvia a linha social (`waha_session_name` nulo,
 * provider `zernio_social`): o `ref` saía nulo, o cron gravava "sem foto" e
 * só revisitava o contato em 7 dias, mesmo com foto disponível no WhatsApp.
 *
 * Este arquivo prova que a foto agora vem da conexão da conversa do contato:
 * lê a conversa mais recente dele, usa a sessão dessa conversa (só se WORKING
 * e não arquivada), resolve o `sessionRef` dela e pede a foto ao adapter dela.
 * Quem tem conversa nunca cai para outra conexão da empresa. Só o contato SEM
 * conversa nenhuma usa a conexão de mensagem da empresa que sabe buscar foto.
 */

const CONTATO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CAMINHO = `${ORG}/avatars/${CONTATO}.jpg`;

/** Chamadas feitas ao `fetchProfilePictureUrl` do adapter. */
const pedidos: Array<{ organizationId: string; sessionRef: string; recipient: string }> = [];
/** Patches recebidos pelo UPDATE de `contacts` (carimbos). */
const updates: Record<string, unknown>[] = [];
/** Linhas devolvidas pelo carimbo: [] = contato anonimizado no meio. */
let linhasAfetadas: { id: string }[] = [];

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo-de-teste", INTERNAL_SECRET: "segredo-de-teste" },
}));

vi.mock("@/lib/channels", () => ({
  DEFAULT_CHANNEL_PROVIDER: "waha",
  CHANNEL_SESSION_REF_COLUMNS:
    "provider, waha_session_name, meta_phone_number_id, zernio_account_id, datafy_phone_number_id",
  resolveSessionRef: (session: {
    provider: string;
    waha_session_name?: string;
    zernio_account_id?: string;
  }) => {
    if (session.provider === "waha") return session.waha_session_name;
    if (session.provider === "zernio" || session.provider === "zernio_social")
      return session.zernio_account_id;
    return null;
  },
  getAdapter: (provider: string) => {
    // O adapter social (Instagram/Facebook) não expõe foto de perfil: é o
    // canal que não tem `fetchProfilePictureUrl`.
    if (provider === "zernio_social") return {};
    return {
      fetchProfilePictureUrl: async (input: {
        organizationId: string;
        sessionRef: string;
        recipient: string;
      }) => {
        pedidos.push(input);
        return "https://cdn.exemplo.invalid/foto.jpg";
      },
    };
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      select: () => {
        let dados: unknown;
        if (tabela === "contacts") {
          dados = [linhaDoContato];
        } else if (tabela === "conversations") {
          dados = conversaDoContato;
        } else {
          // As conexões de mensagem da empresa. Por padrão, só a social: tem
          // ref, mas o adapter dela não busca foto.
          dados = sessoesDaEmpresa;
        }
        const proxy: Record<string, unknown> = new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === "then") {
                return (ok: (v: unknown) => unknown) =>
                  Promise.resolve({ data: dados, error: null }).then(ok);
              }
              if (prop === "maybeSingle") return async () => ({ data: dados, error: null });
              return () => proxy;
            },
          },
        );
        return proxy;
      },
      update: (patch: Record<string, unknown>) => {
        const proxy: Record<string, unknown> = new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === "then") {
                return (ok: (v: unknown) => unknown) => {
                  updates.push(patch);
                  return Promise.resolve({ data: linhasAfetadas, error: null }).then(ok);
                };
              }
              if (prop === "select") {
                return () => {
                  updates.push(patch);
                  return Promise.resolve({ data: linhasAfetadas, error: null });
                };
              }
              return () => proxy;
            },
          },
        );
        return proxy;
      },
      upsert: async () => ({ error: null }),
    }),
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  }),
}));

import { POST } from "@/app/api/v1/cron/contact-avatars/route";

let linhaDoContato: Record<string, unknown> = {};
let conversaDoContato: unknown = null;
const SOCIAL = {
  provider: "zernio_social",
  zernio_account_id: "conta-social-da-empresa",
  status: "WORKING",
  archived_at: null,
};
let sessoesDaEmpresa: unknown[] = [SOCIAL];

beforeEach(() => {
  pedidos.length = 0;
  updates.length = 0;
  linhasAfetadas = [{ id: CONTATO }];
  sessoesDaEmpresa = [SOCIAL];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
  );
});

function chamar(): Promise<Response> {
  return POST(
    new Request("http://localhost/api/v1/cron/contact-avatars", {
      method: "POST",
      headers: { authorization: "Bearer segredo-de-teste" },
    }) as never,
  );
}

function gravouCaminho() {
  return updates.some((u) => u.avatar_storage_path === CAMINHO);
}

function carimbouSemFoto() {
  // Sem foto = o patch do carimbo não traz avatar_storage_path.
  return updates.some((u) => u.avatar_storage_path === undefined);
}

describe("cron de fotos: a foto vem da conexão da conversa do contato", () => {
  it("a) conversa numa sessão WORKING com ref → chama fetchProfilePictureUrl com o ref DESSA sessão", async () => {
    linhaDoContato = {
      id: CONTATO,
      organization_id: ORG,
      wa_identity: "phone:+5511999990000",
      wa_lid: null,
      phone_number: "+5511999990000",
      avatar_storage_path: null,
    };
    conversaDoContato = {
      channel_sessions: {
        provider: "waha",
        waha_session_name: "sessao-do-contato",
        status: "WORKING",
        archived_at: null,
      },
    };

    await chamar();

    expect(pedidos).toEqual([
      { organizationId: ORG, sessionRef: "sessao-do-contato", recipient: "5511999990000@c.us" },
    ]);
    expect(gravouCaminho()).toBe(true);
  });

  it("b) empresa tem sessão social WORKING sem ref, mas conversa do contato é WhatsApp → foto pedida e gravada", async () => {
    linhaDoContato = {
      id: CONTATO,
      organization_id: ORG,
      wa_identity: "phone:+5511999990000",
      wa_lid: null,
      phone_number: "+5511999990000",
      avatar_storage_path: null,
    };
    conversaDoContato = {
      channel_sessions: {
        provider: "waha",
        waha_session_name: "sessao-waha-do-contato",
        status: "WORKING",
        archived_at: null,
      },
    };

    await chamar();

    // A foto vem da sessão da conversa (WhatsApp), nunca da linha social sem ref.
    expect(pedidos).toEqual([
      { organizationId: ORG, sessionRef: "sessao-waha-do-contato", recipient: "5511999990000@c.us" },
    ]);
    expect(gravouCaminho()).toBe(true);
  });

  it("c) conversa numa sessão STOPPED → não chama o canal, carimba sem foto", async () => {
    linhaDoContato = {
      id: CONTATO,
      organization_id: ORG,
      wa_identity: "phone:+5511999990000",
      wa_lid: null,
      phone_number: "+5511999990000",
      avatar_storage_path: null,
    };
    conversaDoContato = {
      channel_sessions: {
        provider: "waha",
        waha_session_name: "sessao-parada",
        status: "STOPPED",
        archived_at: null,
      },
    };

    await chamar();

    expect(pedidos).toEqual([]);
    expect(carimbouSemFoto()).toBe(true);
    expect(gravouCaminho()).toBe(false);
  });

  it("c) conversa arquivada → não chama o canal, carimba sem foto", async () => {
    linhaDoContato = {
      id: CONTATO,
      organization_id: ORG,
      wa_identity: "phone:+5511999990000",
      wa_lid: null,
      phone_number: "+5511999990000",
      avatar_storage_path: null,
    };
    conversaDoContato = {
      channel_sessions: {
        provider: "waha",
        waha_session_name: "sessao-arquivada",
        status: "WORKING",
        archived_at: "2026-10-20T10:00:00Z",
      },
    };

    await chamar();

    expect(pedidos).toEqual([]);
    expect(carimbouSemFoto()).toBe(true);
    expect(gravouCaminho()).toBe(false);
  });

  it("d1) contato sem conversa e empresa com conexão de mensagem que busca foto → pede pela conexão da empresa", async () => {
    linhaDoContato = {
      id: CONTATO,
      organization_id: ORG,
      wa_identity: "phone:+5511999990000",
      wa_lid: null,
      phone_number: "+5511999990000",
      avatar_storage_path: null,
    };
    conversaDoContato = null;
    // A social vem primeiro na ordem: a escolha tem de pular ela pela capacidade.
    sessoesDaEmpresa = [
      SOCIAL,
      { provider: "waha", waha_session_name: "sessao-da-empresa", status: "WORKING", archived_at: null },
    ];

    await chamar();

    expect(pedidos).toEqual([
      { organizationId: ORG, sessionRef: "sessao-da-empresa", recipient: "5511999990000@c.us" },
    ]);
    expect(gravouCaminho()).toBe(true);
  });

  it("d2) contato sem conversa e empresa só com a conexão social → não chama o canal, carimba sem foto", async () => {
    linhaDoContato = {
      id: CONTATO,
      organization_id: ORG,
      wa_identity: "phone:+5511999990000",
      wa_lid: null,
      phone_number: "+5511999990000",
      avatar_storage_path: null,
    };
    conversaDoContato = null;

    await chamar();

    expect(pedidos).toEqual([]);
    expect(carimbouSemFoto()).toBe(true);
    expect(gravouCaminho()).toBe(false);
  });

  it("e) sessão da conversa é de adapter sem fetchProfilePictureUrl (social) → carimba sem foto, sem erro", async () => {
    linhaDoContato = {
      id: CONTATO,
      organization_id: ORG,
      wa_identity: "phone:+5511999990000",
      wa_lid: null,
      phone_number: "+5511999990000",
      avatar_storage_path: null,
    };
    conversaDoContato = {
      channel_sessions: {
        provider: "zernio_social",
        zernio_account_id: "conta-social-da-empresa",
        status: "WORKING",
        archived_at: null,
      },
    };

    await chamar();

    expect(pedidos).toEqual([]);
    expect(carimbouSemFoto()).toBe(true);
    expect(gravouCaminho()).toBe(false);
  });
});
