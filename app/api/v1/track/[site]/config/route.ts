/**
 * GET /api/v1/track/[site]/config — config PÚBLICA e não-secreta que o
 * tracker.js busca uma vez por carregamento de página, pra saber se/como
 * disparar Pixel/gtag client-side. `site` é o `site_key` de `tracking_sites`
 * — nunca um id interno.
 *
 * Item 8 do pedido: só o que já é público em QUALQUER instalação normal de
 * Meta Pixel/gtag (ids de pixel/measurement/conversion) sai daqui. Token de
 * acesso, api_secret, developer_token, refresh_token — nenhum desses chega
 * perto desta rota; ficam em `secrets_encrypted`, lidos só server-side pelos
 * adapters em `lib/plataformas-de-anuncio/`.
 */
import { NextResponse, type NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ site: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const { site } = await ctx.params;
  if (!site || site.length < 8) {
    return NextResponse.json(null, { status: 404 });
  }

  const admin = createAdminClient();
  const { data: trackingSite } = await admin
    .from("tracking_sites")
    .select("id, organization_id, is_active")
    .eq("site_key", site)
    .maybeSingle();

  if (!trackingSite || !(trackingSite as { is_active: boolean }).is_active) {
    return NextResponse.json(null, { status: 404 });
  }

  const organizationId = (trackingSite as { organization_id: string }).organization_id;

  const { data: settings } = await admin
    .from("integration_settings")
    .select("provider, enabled, config")
    .eq("organization_id", organizationId)
    .eq("enabled", true)
    .in("provider", ["META", "GA4", "GOOGLE_ADS"]);

  const porProvider = new Map(
    ((settings ?? []) as { provider: string; config: Record<string, unknown> | null }[]).map((s) => [
      s.provider,
      s.config ?? {},
    ]),
  );

  const meta = porProvider.get("META");
  const ga4 = porProvider.get("GA4");
  const googleAds = porProvider.get("GOOGLE_ADS");

  const corpo = {
    meta_pixel_id: typeof meta?.pixel_id === "string" ? meta.pixel_id : null,
    ga4_measurement_id: typeof ga4?.measurement_id === "string" ? ga4.measurement_id : null,
    google_ads_conversion_id:
      typeof googleAds?.aw_conversion_id === "string" ? googleAds.aw_conversion_id : null,
    google_ads_contact_label:
      typeof googleAds?.aw_contact_label === "string" ? googleAds.aw_contact_label : null,
  };

  return NextResponse.json(corpo, {
    status: 200,
    headers: { "cache-control": "public, max-age=300" },
  });
}
