import type { SupabaseClient } from "@supabase/supabase-js";

export interface EstadoDoProvider {
  provider: "META" | "GA4" | "GOOGLE_ADS";
  conectado: boolean;
  habilitado: boolean;
  temSegredo: boolean;
  config: Record<string, unknown>;
}

const PROVIDERS: EstadoDoProvider["provider"][] = ["META", "GA4", "GOOGLE_ADS"];

export async function lerEstadoDosProviders(
  admin: SupabaseClient,
  organizationId: string,
): Promise<Record<EstadoDoProvider["provider"], EstadoDoProvider>> {
  const { data } = await admin
    .from("integration_settings")
    .select("provider, enabled, config, secrets_encrypted")
    .eq("organization_id", organizationId);

  const linhas = new Map(
    ((data ?? []) as {
      provider: EstadoDoProvider["provider"];
      enabled: boolean;
      config: Record<string, unknown> | null;
      secrets_encrypted: string | null;
    }[]).map((l) => [l.provider, l]),
  );

  const resultado = {} as Record<EstadoDoProvider["provider"], EstadoDoProvider>;
  for (const provider of PROVIDERS) {
    const linha = linhas.get(provider);
    resultado[provider] = {
      provider,
      conectado: Boolean(linha),
      habilitado: linha?.enabled ?? false,
      temSegredo: Boolean(linha?.secrets_encrypted),
      config: linha?.config ?? {},
    };
  }
  return resultado;
}

export interface TrackingSiteComDominios {
  id: string;
  name: string;
  siteKey: string;
  isActive: boolean;
  domains: string[];
}

export async function lerTrackingSites(
  admin: SupabaseClient,
  organizationId: string,
): Promise<TrackingSiteComDominios[]> {
  const { data: sites } = await admin
    .from("tracking_sites")
    .select("id, name, site_key, is_active")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });

  const linhas = (sites ?? []) as { id: string; name: string; site_key: string; is_active: boolean }[];
  if (!linhas.length) return [];

  const { data: dominios } = await admin
    .from("tracking_domains")
    .select("tracking_site_id, domain")
    .in(
      "tracking_site_id",
      linhas.map((l) => l.id),
    );
  const porSite = new Map<string, string[]>();
  for (const d of (dominios ?? []) as { tracking_site_id: string; domain: string }[]) {
    const lista = porSite.get(d.tracking_site_id) ?? [];
    lista.push(d.domain);
    porSite.set(d.tracking_site_id, lista);
  }

  return linhas.map((l) => ({
    id: l.id,
    name: l.name,
    siteKey: l.site_key,
    isActive: l.is_active,
    domains: porSite.get(l.id) ?? [],
  }));
}

// A leitura de auditoria (o que `/app/integrations/rastreamento/auditoria`
// mostra) mora em `lib/rastreamento/auditoria.ts` — 4 seções (eventos
// internos, fila de envio, log bruto por plataforma, ações administrativas),
// não só o resumo de `outbound_events` que vivia aqui. `LinhaDeAuditoria`/
// `lerAuditoria` foram substituídos por esse módulo.
