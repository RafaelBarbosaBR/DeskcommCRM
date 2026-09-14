/**
 * GET /api/v1/track/t.js — o tracker.js, um script só, igual pra todos os
 * sites (a identidade do site vem do `data-site` na própria tag, lido em
 * runtime pelo script — não geramos um arquivo por tenant). Público, sem
 * autenticação, cacheável por um bom tempo (o conteúdo só muda em deploy).
 */
import { NextResponse } from "next/server";

import { TRACKER_JS_SOURCE } from "@/lib/rastreamento/captura/tracker-source";

export const dynamic = "force-static";
export const runtime = "nodejs";

export function GET(): NextResponse {
  return new NextResponse(TRACKER_JS_SOURCE, {
    status: 200,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}
