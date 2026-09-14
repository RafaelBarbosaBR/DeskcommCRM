/**
 * POST /api/v1/track/[site]/collect — o coletor público do tracker.js.
 *
 * Mesmo padrão de `webhooks/in/[token]`: `site` (site_key) no path resolve
 * organization_id — a fonte confiável é sempre o path, nunca o corpo. Grava
 * visitor/session/touchpoint sempre; contato só é resolvido/criado no caso
 * `form_submit` (nunca em `whatsapp_click` — item 3 do pedido: clique de
 * WhatsApp é só detecção, sem contact_id/lead_id).
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { ipDoClienteParaInet } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";
import { normalizePhoneBR } from "@/lib/webhooks/inbound";
import { encontrarContatoPorTelefoneComNome } from "@/lib/channels/contato-por-telefone";
import { registrarEventoInterno } from "@/lib/rastreamento/motor/registrar-evento";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ site: string }>;
}

const RATE_LIMIT_PER_MIN = 120;

interface CorpoDeColeta {
  type?: string;
  event_id?: string;
  visitor_id?: string;
  session_id?: string;
  url?: string;
  referrer?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_term?: string | null;
  utm_content?: string | null;
  fbclid?: string | null;
  fbc?: string | null;
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
  email?: string | null;
  phone?: string | null;
  name?: string | null;
}

function campo(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { site } = await ctx.params;
  if (!site || site.length < 8) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }

  const ip = ipDoClienteParaInet(req.headers) ?? "sem-ip";
  const rl = await checkRateLimit(`track_collect:${site}:${ip}`, RATE_LIMIT_PER_MIN, 60);
  if (!rl.allowed) {
    return NextResponse.json({ ok: false }, { status: 429, headers: { "Retry-After": "60" } });
  }

  const admin = createAdminClient();
  const { data: trackingSite } = await admin
    .from("tracking_sites")
    .select("id, organization_id, is_active")
    .eq("site_key", site)
    .maybeSingle();

  if (!trackingSite || !(trackingSite as { is_active: boolean }).is_active) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }
  const { id: trackingSiteId, organization_id: organizationId } = trackingSite as {
    id: string;
    organization_id: string;
  };

  // Allowlist de domínio — defesa em profundidade, não o mecanismo de
  // autenticação (esse é o site_key no path). Permissivo se ninguém
  // cadastrou domínio ainda, pra não travar o primeiro deploy do snippet.
  const origin = req.headers.get("origin");
  if (origin) {
    const { data: dominios } = await admin
      .from("tracking_domains")
      .select("domain")
      .eq("tracking_site_id", trackingSiteId);
    const lista = (dominios ?? []) as { domain: string }[];
    if (lista.length > 0) {
      let host = "";
      try {
        host = new URL(origin).host;
      } catch {
        host = "";
      }
      const permitido = lista.some((d) => d.domain === host);
      if (!permitido) {
        logger.warn("[rastreamento.coletor] origin fora da allowlist", {
          organizationId,
          trackingSiteId,
          origin,
        });
        return NextResponse.json({ ok: false }, { status: 403 });
      }
    }
  }

  let body: CorpoDeColeta;
  try {
    body = (await req.json()) as CorpoDeColeta;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const tipo = body.type;
  const visitorIdCookie = campo(body.visitor_id);
  const sessionIdCookie = campo(body.session_id);
  if (!tipo || !visitorIdCookie) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const nowIso = new Date().toISOString();

  // Visitante: upsert por (tracking_site_id, visitor_id do cookie).
  const { data: visitorExistente } = await admin
    .from("visitors")
    .select("id")
    .eq("tracking_site_id", trackingSiteId)
    .eq("visitor_id", visitorIdCookie)
    .maybeSingle();

  let visitorRowId: string;
  if (visitorExistente) {
    visitorRowId = (visitorExistente as { id: string }).id;
    await admin.from("visitors").update({ last_seen_at: nowIso }).eq("id", visitorRowId);
  } else {
    const { data: criado, error: erroVisitante } = await admin
      .from("visitors")
      .insert({
        organization_id: organizationId,
        tracking_site_id: trackingSiteId,
        visitor_id: visitorIdCookie,
      })
      .select("id")
      .maybeSingle();
    if (erroVisitante || !criado) {
      // Corrida: duas abas da mesma pessoa carregaram a página ao mesmo
      // tempo. Relê o vencedor em vez de falhar a requisição.
      const { data: relido } = await admin
        .from("visitors")
        .select("id")
        .eq("tracking_site_id", trackingSiteId)
        .eq("visitor_id", visitorIdCookie)
        .maybeSingle();
      if (!relido) return NextResponse.json({ ok: false }, { status: 500 });
      visitorRowId = (relido as { id: string }).id;
    } else {
      visitorRowId = (criado as { id: string }).id;
    }
  }

  // Sessão: upsert por session_id do cookie, se veio.
  let sessionRowId: string | null = null;
  if (sessionIdCookie) {
    const { data: sessaoExistente } = await admin
      .from("sessions")
      .select("id")
      .eq("session_id", sessionIdCookie)
      .maybeSingle();
    if (sessaoExistente) {
      sessionRowId = (sessaoExistente as { id: string }).id;
      await admin.from("sessions").update({ last_seen_at: nowIso }).eq("id", sessionRowId);
    } else {
      const { data: criada } = await admin
        .from("sessions")
        .insert({
          organization_id: organizationId,
          visitor_id: visitorRowId,
          session_id: sessionIdCookie,
          referrer: campo(body.referrer),
          landing_url: campo(body.url),
          utm_source: campo(body.utm_source),
          utm_medium: campo(body.utm_medium),
          utm_campaign: campo(body.utm_campaign),
          utm_term: campo(body.utm_term),
          utm_content: campo(body.utm_content),
        })
        .select("id")
        .maybeSingle();
      sessionRowId = (criada as { id: string } | null)?.id ?? null;
    }
  }

  // Contato: só resolvido/criado em form_submit. whatsapp_click nunca tem
  // contact_id nem lead_id (item 3) — é só sinal de clique.
  let contactId: string | null = null;
  if (tipo === "form_submit") {
    const telefone = normalizePhoneBR(body.phone);
    const email = campo(body.email);
    if (telefone) {
      const achado = await encontrarContatoPorTelefoneComNome(admin, organizationId, telefone);
      if (achado) {
        contactId = achado.id;
      } else {
        const { data: criado, error: erroContato } = await admin
          .from("contacts")
          .insert({
            organization_id: organizationId,
            name: campo(body.name) ?? telefone,
            phone_number: telefone,
            email,
            source: "tracking",
            source_metadata: { tracking_site_id: trackingSiteId },
          })
          .select("id")
          .maybeSingle();
        if (erroContato) {
          // 23505: alguém (o webhook real de captação, correndo em
          // paralelo) já criou este contato pelo mesmo telefone/email.
          const reachado = await encontrarContatoPorTelefoneComNome(admin, organizationId, telefone);
          contactId = reachado?.id ?? null;
        } else {
          contactId = (criado as { id: string } | null)?.id ?? null;
        }
      }
    }
    if (contactId) {
      // First-touch: só carimba visitor_id se ainda não tinha nenhum — nunca
      // sobrescreve a origem já registrada.
      await admin
        .from("contacts")
        .update({ visitor_id: visitorRowId })
        .eq("id", contactId)
        .is("visitor_id", null);
    }
  }

  // Touchpoint: um por interação. fbclid/fbc/gclid/gbraid/wbraid ficam null
  // quando ausentes — nunca inventados (item 1).
  const { data: touchpoint } = await admin
    .from("touchpoints")
    .insert({
      organization_id: organizationId,
      visitor_id: visitorRowId,
      session_id: sessionRowId,
      url: campo(body.url),
      referrer: campo(body.referrer),
      utm_source: campo(body.utm_source),
      utm_medium: campo(body.utm_medium),
      utm_campaign: campo(body.utm_campaign),
      utm_term: campo(body.utm_term),
      utm_content: campo(body.utm_content),
      fbclid: campo(body.fbclid),
      fbc: campo(body.fbc),
      gclid: campo(body.gclid),
      gbraid: campo(body.gbraid),
      wbraid: campo(body.wbraid),
      contact_id: contactId,
    })
    .select("id")
    .maybeSingle();
  const touchpointId = (touchpoint as { id: string } | null)?.id ?? null;

  const tipoInterno = tipo === "page_view" ? "PAGE_VIEW" : "CONTACT";
  await registrarEventoInterno(admin, {
    organizationId,
    trackingSiteId,
    tipo: tipoInterno,
    visitorId: visitorRowId,
    sessionId: sessionRowId,
    contactId,
    touchpointId,
    payload: {
      whatsapp_click: tipo === "whatsapp_click",
      fbclid: campo(body.fbclid),
      fbc: campo(body.fbc),
      gclid: campo(body.gclid),
      gbraid: campo(body.gbraid),
      wbraid: campo(body.wbraid),
    },
  });

  return NextResponse.json({ ok: true }, { status: 200, headers: { "X-Request-Id": requestId } });
}
