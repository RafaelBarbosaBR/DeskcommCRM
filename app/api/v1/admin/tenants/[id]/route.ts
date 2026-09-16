import { type NextRequest } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { randomUUID } from "node:crypto";
import { estadoDoAgente } from "@/lib/ai/agents/no-ar";

// ---------------------------------------------------------------------------
// GET /api/v1/admin/tenants/[id]
// ---------------------------------------------------------------------------

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = randomUUID();
  const { id } = await params;

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const admin = createAdminClient();

  // Load the organization (service-role bypasses RLS — intentional cross-tenant)
  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select(
      `
      id,
      slug,
      display_name,
      legal_name,
      cnpj,
      status,
      onboarded_at,
      suspended_at,
      created_at,
      settings
    `,
    )
    .eq("id", id)
    .single();

  if (orgError || !org) {
    return fail("not_found", "Tenant not found", 404, { requestId });
  }

  // Run counts in parallel — service role, all cross-tenant reads are intentional
  const [
    usersRes,
    conversationsRes,
    messagesRes,
    leadsRes,
    ordersRes,
    lgpdRes,
    aiRes,
    wahaRes,
    integrationRes,
    agentsRes,
  ] = await Promise.all([
    admin
      .from("user_organizations")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id),
    admin
      .from("conversations")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id),
    admin
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id),
    admin
      .from("crm_leads")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id),
    admin
      .from("orders")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id),
    admin
      .from("lgpd_requests")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id)
      // `pending` não existe em `lgpd_requests_status_check`
      // (received/processing/completed/failed/expired), então este contador era
      // sempre 0 e a tela jurava que o tenant não devia nada à LGPD. Aqui
      // pendente = TUDO que ainda não fechou, sem recorte de prazo. O KPI de
      // plataforma (`app/api/v1/admin/dashboard/kpis/route.ts`) parte do mesmo
      // "não fechado" mas soma só o que vence nos próximos 5 dias — os dois
      // números divergem de propósito: este é o total do tenant, aquele é a
      // fila de SLA da plataforma.
      .not("status", "in", "(completed,failed)"),
    // `llm_calls` e não `ai_invocations`: a migration 0130 deixou a segunda sem
    // nenhum escritor (`lib/ai/log-invocation.ts` passou a gravar na primeira).
    // Lendo a tabela morta, este contador viraria ZERO em 30 dias para todo
    // tenant — com o dinheiro saindo. É o mesmo sintoma que a 0130 veio matar.
    admin
      .from("llm_calls")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id)
      .gte(
        "created_at",
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      ),
    admin
      .from("channel_sessions")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id),
    admin
      .from("tenant_integrations")
      // `connected_at` não existe: a linha passa a existir quando a integração
      // é conectada, então `created_at` é essa mesma data com o nome real.
      .select("id, provider, status, created_at")
      .eq("organization_id", id)
      .eq("provider", "nuvemshop")
      .limit(1),
    // Arquivado sai da lista de propósito: quem quer ver o que já foi
    // desligado usa a tela de agentes do próprio tenant, não o painel de
    // plataforma — aqui a pergunta é "o que está rodando/configurado agora".
    admin
      .from("ai_agents")
      .select("id, name, kind, is_active, paused_at, archived_at, published_version_id, model")
      .eq("organization_id", id)
      .is("archived_at", null)
      .order("created_at", { ascending: true }),
  ]);

  const counts = {
    user_count: usersRes.count ?? 0,
    conversations_count: conversationsRes.count ?? 0,
    messages_count: messagesRes.count ?? 0,
    leads_count: leadsRes.count ?? 0,
    orders_count: ordersRes.count ?? 0,
    lgpd_requests_pending: lgpdRes.count ?? 0,
    ai_invocations_30d: aiRes.count ?? 0,
    waha_sessions_count: wahaRes.count ?? 0,
  };

  const nuvemshopIntegration =
    integrationRes.data && integrationRes.data.length > 0
      ? integrationRes.data[0]
      : null;

  const integrations = {
    nuvemshop_status: nuvemshopIntegration?.status ?? null,
    // Nome de SAÍDA preservado: é o que TenantOverview já lê. Só a coluna de
    // origem estava errada.
    nuvemshop_connected_at: nuvemshopIntegration?.created_at ?? null,
  };

  // A versão PUBLICADA é a segunda leitura: `ai_agents.model` é o rascunho, que
  // pode ter sido editado depois da última publicação — o modelo REALMENTE em
  // produção mora em `ai_agent_versions`. Sem esta segunda consulta, um agente
  // editado-mas-não-republicado mostraria um modelo que o cliente nunca recebeu.
  const agentRows = agentsRes.data ?? [];
  const publishedVersionIds = agentRows
    .map((a) => a.published_version_id)
    .filter((v): v is string => v != null);
  const { data: versionRows } =
    publishedVersionIds.length > 0
      ? await admin
          .from("ai_agent_versions")
          .select("id, model, version_number, published_at")
          .in("id", publishedVersionIds)
      : { data: [] as Array<{ id: string; model: string; version_number: number; published_at: string | null }> };
  const versaoPorId = new Map((versionRows ?? []).map((v) => [v.id, v]));

  const agents = agentRows.map((a) => {
    const versao = a.published_version_id ? versaoPorId.get(a.published_version_id) : undefined;
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      // Reusa a MESMA régua de "está no ar" do resto do produto
      // (`lib/ai/agents/no-ar.ts`) — não uma quarta cópia da condição.
      status: estadoDoAgente(a),
      model: versao?.model ?? a.model,
      version_number: versao?.version_number ?? null,
      published_at: versao?.published_at ?? null,
    };
  });

  // Audit lightweight — fire-and-forget
  void audit({
    action: "platform_admin.tenant_viewed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: id,
    resourceType: "organization",
    resourceId: id,
    requestId,
    metadata: { tenant_slug: org.slug },
  });

  return ok({ organization: org, counts, integrations, agents }, { requestId });
}
