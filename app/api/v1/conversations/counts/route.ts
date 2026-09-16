/**
 * GET /api/v1/conversations/counts — contagens por visão do inbox (G4-02).
 *
 * Usa o client user-scoped (cookie session) → toda contagem HERDA a RLS de
 * SELECT de `conversations` (fn_can_view_conversation, migration 0035). Um agent
 * em modo own* recebe a contagem do SEU escopo, NUNCA o total da org — a mesma
 * garantia do listing. Head count (count:'exact', head:true) não devolve linhas.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { CONVERSATION_TERMINAL_STATUSES, conversationCountsQuerySchema } from "@/lib/schemas";
import { orgTemAutomatico } from "@/lib/ai/agents/org-tem-automatico";
import { comandosDaFila } from "@/lib/inbox/comando-da-conversa";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const authUser = await loadAuthUser();
  const activeOrg = authUser ? await resolveActiveOrg(authUser) : null;
  if (!activeOrg) {
    return fail(
      "no_active_org",
      traduzir("No active organization.", authUser?.idioma ?? "pt-BR"),
      403,
      { requestId },
    );
  }

  const url = new URL(req.url);
  const qsParsed = conversationCountsQuerySchema.safeParse({
    channel_session_id: url.searchParams.get("channel_session_id") ?? undefined,
    tag: url.searchParams.get("tag") ?? undefined,
    only_unread: url.searchParams.get("only_unread") === "true" ? true : undefined,
  });
  if (!qsParsed.success) {
    return fail(
      "validation_failed",
      traduzir("Query inválida.", authUser?.idioma ?? "pt-BR"),
      422,
      { details: qsParsed.error.flatten().fieldErrors as Record<string, unknown>, requestId },
    );
  }
  const { channel_session_id, tag, only_unread } = qsParsed.data;

  const org = activeOrg.orgId;
  // Os mesmos três filtros que a listagem aplica (ver `_handler.ts`) — sem eles
  // o badge conta a organização inteira enquanto a lista embaixo já veio
  // filtrada, e os dois números discordam entre si.
  const countExact = () => {
    let q = supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org);
    if (channel_session_id) q = q.eq("channel_session_id", channel_session_id);
    if (tag) q = q.contains("tags", [tag]);
    if (only_unread) q = q.gt("unread_count_for_assignee", 0);
    return q;
  };

  // Espelha tabToFilter (InboxLayout): unassigned = fila aberta sem dono;
  // mine = atribuídas a mim e ainda ABERTAS; all = tudo que o usuário VÊ.
  //
  // O `not in (terminais)` do `mine` espelha o `exclude_finished` da aba, e o
  // espelhamento é o ponto: um badge que conta o que a aba não mostra é pior
  // que badge nenhum — manda o atendente procurar um trabalho que não existe.
  // O fato ORG-WIDE resolvido ANTES das contagens, porque ele escolhe QUAL
  // conjunto de comandos a Fila pede. `undefined` (não deu para saber) segue a
  // convenção da regra: assume que há automático.
  const automaticoDaOrg = await orgTemAutomatico(supabase, org);

  const [fila, automatico, mine, all, closed] = await Promise.all([
    // A FILA DEIXOU DE SER "sem dono + status de espera".
    //
    // Aquele par contava como trabalho humano pendente tudo que o robô estava
    // atendendo: medido na VPS em 2026-08-30, o badge dizia 83 enquanto 47
    // daquelas conversas tinham o automático no comando. Agora ele conta o mesmo
    // predicado que a aba pede — e o espelhamento entre badge e aba é vigiado
    // por `tests/unit/badge-espelha-a-aba.test.ts`, porque um badge que conta o
    // que a aba não mostra manda o atendente procurar trabalho que não existe.
    countExact().in("comando_da_conversa", comandosDaFila(automaticoDaOrg)),
    // A aba "Automático". Antes ela pedia `status='ai_handling'`, escrito por UM
    // caminho só em produção — por isso vivia quase vazia.
    countExact().eq("comando_da_conversa", "automatico"),
    countExact()
      .eq("assigned_to_user_id", user.id)
      .not("status", "in", `(${CONVERSATION_TERMINAL_STATUSES.join(",")})`),
    countExact(),
    // Espelha `tabToFilter("closed")`: `{ status: "closed" }`. A aba "Fechadas"
    // vivia sem número no badge — não por decisão, só por nunca ter entrado
    // neste `Promise.all` quando as outras quatro entraram.
    countExact().eq("status", "closed"),
  ]);

  const firstErr = fila.error ?? automatico.error ?? mine.error ?? all.error ?? closed.error;
  if (firstErr) {
    return fail("internal_error", firstErr.message, 500, { requestId });
  }

  return ok(
    {
      fila: fila.count ?? 0,
      automatico: automatico.count ?? 0,
      closed: closed.count ?? 0,
      // `unassigned` continua respondendo, com o MESMO valor de `fila`. É rota
      // `/api/v1/` versionada: campo não some de uma versão para outra, e um
      // cliente com a página aberta desde antes do deploy segue lendo o nome
      // velho até recarregar.
      unassigned: fila.count ?? 0,
      mine: mine.count ?? 0,
      all: all.count ?? 0,
    },
    { requestId },
  );
}
