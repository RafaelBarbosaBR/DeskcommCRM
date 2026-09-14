/**
 * POST /api/v1/track/[site]/pixel-ack — ping best-effort do tracker.js
 * depois de chamar `fbq()`, só pra marcar `meta_event_logs.pixel_fired`.
 * Falha aqui nunca derruba nada (é só visibilidade extra no log de
 * auditoria — item 7 do pedido) e nunca cria linha nova: só atualiza um
 * `internal_event_id` que o despacho já deve ter criado.
 */
import { NextResponse, type NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { ipDoClienteParaInet } from "@/lib/http/ip-do-cliente";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ site: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const { site } = await ctx.params;
  if (!site || site.length < 8) return NextResponse.json({ ok: false }, { status: 404 });

  const ip = ipDoClienteParaInet(req.headers) ?? "sem-ip";
  const rl = await checkRateLimit(`track_ack:${site}:${ip}`, 120, 60);
  if (!rl.allowed) return NextResponse.json({ ok: false }, { status: 429 });

  let body: { event_id?: string };
  try {
    body = (await req.json()) as { event_id?: string };
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const eventId = typeof body.event_id === "string" ? body.event_id.trim() : "";
  if (!eventId) return NextResponse.json({ ok: false }, { status: 400 });

  const admin = createAdminClient();
  // `meta_event_logs` só existe depois que o despacho roda pelo menos uma
  // vez (ele é quem cria a linha). Um ack que chega antes disso — a rede do
  // visitante é mais rápida que o drain do event_log — não tem o que
  // atualizar ainda; não é erro, só corrida benigna.
  await admin
    .from("meta_event_logs")
    .update({ pixel_fired: true })
    .eq("event_id", eventId);

  return NextResponse.json({ ok: true }, { status: 200 });
}
