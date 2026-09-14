import Link from "next/link";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  lerAcoesAdministrativas,
  lerAcoesDistintas,
  lerEventosInternos,
  lerFilaDeEnvio,
  lerLogsDePlataforma,
  type LinhaDeAcaoAdministrativa,
  type LinhaDeEventoInterno,
  type LinhaDaFilaDeEnvio,
  type LinhaDeLogDePlataforma,
  type ProviderDeRastreamento,
  type StatusDeEnvio,
  type StatusDoLog,
} from "@/lib/rastreamento/auditoria";
import { TIPOS_DE_EVENTO_INTERNO, type TipoDeEventoInterno } from "@/lib/rastreamento/motor/types";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Auditoria de rastreamento" };
export const dynamic = "force-dynamic";

const ROTULO_DO_TIPO: Record<TipoDeEventoInterno, string> = {
  PAGE_VIEW: "Visualização de página",
  CONTACT: "Contato",
  LEAD: "Lead",
  QUALIFIED: "Qualificado",
  PURCHASE: "Compra",
};

const PROVIDERS: ProviderDeRastreamento[] = ["META", "GA4", "GOOGLE_ADS"];
const ROTULO_DO_PROVIDER: Record<ProviderDeRastreamento, string> = {
  META: "Meta",
  GA4: "GA4",
  GOOGLE_ADS: "Google Ads",
};

const STATUS_DE_ENVIO: StatusDeEnvio[] = ["pending", "processing", "sent", "failed", "dead_letter"];
const ROTULO_DO_STATUS_DE_ENVIO: Record<StatusDeEnvio, string> = {
  pending: "pendente",
  processing: "processando",
  sent: "enviado",
  failed: "falhou",
  dead_letter: "esgotado",
};
const COR_DO_STATUS_DE_ENVIO: Record<StatusDeEnvio, string> = {
  pending: "bg-amber-500/15 text-amber-600",
  processing: "bg-sky-500/15 text-sky-600",
  sent: "bg-emerald-500/15 text-emerald-600",
  failed: "bg-red-500/15 text-red-600",
  dead_letter: "bg-red-700/15 text-red-700",
};

const STATUS_DO_LOG: StatusDoLog[] = ["ok", "erro"];
const COR_DO_STATUS_DO_LOG: Record<StatusDoLog, string> = {
  ok: "bg-emerald-500/15 text-emerald-600",
  erro: "bg-red-500/15 text-red-600",
};

interface Filtros {
  a_tipo?: string;
  b_status?: string;
  b_provider?: string;
  c_status?: string;
  d_acao?: string;
}

/** Monta a URL do próprio chip: preserva os filtros das OUTRAS seções, troca só o da sua. */
function hrefComFiltro(atual: Filtros, chave: keyof Filtros, valor: string | null): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(atual)) {
    if (v && k !== chave) params.set(k, v);
  }
  if (valor) params.set(chave, valor);
  const query = params.toString();
  return `/app/integrations/rastreamento/auditoria${query ? `?${query}` : ""}#${chave}`;
}

function Chip({
  ativo,
  href,
  children,
}: {
  ativo: boolean;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
        ativo
          ? "border-accent bg-accent/10 font-medium text-accent"
          : "border-border text-muted-foreground hover:text-text"
      }`}
    >
      {children}
    </Link>
  );
}

function Badge({ cor, children }: { cor: string; children: React.ReactNode }) {
  return <span className={`rounded px-2 py-0.5 text-xs ${cor}`}>{children}</span>;
}

function Secao({
  id,
  titulo,
  descricao,
  chips,
  children,
}: {
  id: string;
  titulo: string;
  descricao: string;
  chips: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="flex scroll-mt-6 flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">{titulo}</h2>
        <p className="text-sm text-muted-foreground">{descricao}</p>
      </div>
      <div className="flex flex-wrap gap-2">{chips}</div>
      {children}
    </section>
  );
}

function TabelaVazia({ texto }: { texto: string }) {
  return <p className="rounded-md border p-4 text-sm text-muted-foreground">{texto}</p>;
}

export default async function AuditoriaDeRastreamentoPage({
  searchParams,
}: {
  searchParams: Promise<Filtros>;
}) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  const filtros = await searchParams;
  const tipo = TIPOS_DE_EVENTO_INTERNO.includes(filtros.a_tipo as TipoDeEventoInterno)
    ? (filtros.a_tipo as TipoDeEventoInterno)
    : undefined;
  const bStatus = STATUS_DE_ENVIO.includes(filtros.b_status as StatusDeEnvio)
    ? (filtros.b_status as StatusDeEnvio)
    : undefined;
  const bProvider = PROVIDERS.includes(filtros.b_provider as ProviderDeRastreamento)
    ? (filtros.b_provider as ProviderDeRastreamento)
    : undefined;
  const cStatus = STATUS_DO_LOG.includes(filtros.c_status as StatusDoLog)
    ? (filtros.c_status as StatusDoLog)
    : undefined;
  const acao = filtros.d_acao?.trim() || undefined;

  const admin = createAdminClient();
  const [eventos, fila, logs, acoesDistintas, acoes] = await Promise.all([
    lerEventosInternos(admin, activeOrg.orgId, { tipo }),
    lerFilaDeEnvio(admin, activeOrg.orgId, { status: bStatus, provider: bProvider }),
    lerLogsDePlataforma(admin, activeOrg.orgId, { status: cStatus }),
    lerAcoesDistintas(admin, activeOrg.orgId),
    lerAcoesAdministrativas(admin, activeOrg.orgId, { action: acao }),
  ]);

  return (
    <div className="flex h-full flex-col gap-10 overflow-y-auto p-6">
      <header>
        <Link
          href="/app/integrations/rastreamento"
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          {t("← Rastreamento")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("Auditoria de rastreamento")}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(
            "O que aconteceu com cada evento de tracking, do nascimento à resposta real de cada plataforma. Nenhum status de sucesso aqui foi inventado — todo \"enviado\" veio de uma confirmação de verdade da API.",
          )}
        </p>
      </header>

      {/* (a) Eventos internos */}
      <Secao
        id="a_tipo"
        titulo={t("Eventos internos")}
        descricao={t(
          "O registro de conversão em si — page view, contato, lead, qualificado, compra.",
        )}
        chips={
          <>
            <Chip ativo={!tipo} href={hrefComFiltro(filtros, "a_tipo", null)}>
              {t("Todos")}
            </Chip>
            {TIPOS_DE_EVENTO_INTERNO.map((tp) => (
              <Chip key={tp} ativo={tipo === tp} href={hrefComFiltro(filtros, "a_tipo", tp)}>
                {t(ROTULO_DO_TIPO[tp])}
              </Chip>
            ))}
          </>
        }
      >
        {eventos.length === 0 ? (
          <TabelaVazia texto={t("Nenhum evento interno ainda com este filtro.")} />
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-3 font-medium">{t("Quando")}</th>
                  <th className="p-3 font-medium">{t("Tipo")}</th>
                  <th className="p-3 font-medium">{t("Relacionado")}</th>
                </tr>
              </thead>
              <tbody>
                {eventos.map((e: LinhaDeEventoInterno) => (
                  <tr key={e.id} className="border-t align-top">
                    <td className="p-3 whitespace-nowrap text-muted-foreground">
                      {new Date(e.occurredAt).toLocaleString(idioma)}
                    </td>
                    <td className="p-3">{t(ROTULO_DO_TIPO[e.eventType] ?? e.eventType)}</td>
                    <td className="p-3">
                      {e.leadId ? (
                        <Link
                          className="underline underline-offset-2"
                          href={`/app/leads/${e.leadId}`}
                        >
                          {e.leadTitle ?? t("(negócio sem título)")}
                        </Link>
                      ) : e.contactId ? (
                        <Link
                          className="underline underline-offset-2"
                          href={`/app/contacts/${e.contactId}`}
                        >
                          {e.contactName ?? t("(contato sem nome)")}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Secao>

      {/* (b) Fila de envio */}
      <Secao
        id="b_status"
        titulo={t("Fila de envio")}
        descricao={t(
          "Uma linha por evento×plataforma: status, tentativas, próxima tentativa e o erro real quando falhou.",
        )}
        chips={
          <>
            <span className="mr-1 self-center text-xs text-muted-foreground">{t("Status:")}</span>
            <Chip ativo={!bStatus} href={hrefComFiltro(filtros, "b_status", null)}>
              {t("Todos")}
            </Chip>
            {STATUS_DE_ENVIO.map((s) => (
              <Chip key={s} ativo={bStatus === s} href={hrefComFiltro(filtros, "b_status", s)}>
                {t(ROTULO_DO_STATUS_DE_ENVIO[s])}
              </Chip>
            ))}
            <span className="ml-3 mr-1 self-center text-xs text-muted-foreground">
              {t("Plataforma:")}
            </span>
            <Chip ativo={!bProvider} href={hrefComFiltro(filtros, "b_provider", null)}>
              {t("Todas")}
            </Chip>
            {PROVIDERS.map((p) => (
              <Chip key={p} ativo={bProvider === p} href={hrefComFiltro(filtros, "b_provider", p)}>
                {ROTULO_DO_PROVIDER[p]}
              </Chip>
            ))}
          </>
        }
      >
        {fila.length === 0 ? (
          <TabelaVazia texto={t("Nada na fila com este filtro.")} />
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-3 font-medium">{t("Plataforma")}</th>
                  <th className="p-3 font-medium">{t("Evento")}</th>
                  <th className="p-3 font-medium">{t("Status")}</th>
                  <th className="p-3 font-medium">{t("Tentativas")}</th>
                  <th className="p-3 font-medium">{t("Última tentativa")}</th>
                  <th className="p-3 font-medium">{t("Próxima tentativa")}</th>
                  <th className="p-3 font-medium">{t("Erro")}</th>
                </tr>
              </thead>
              <tbody>
                {fila.map((f: LinhaDaFilaDeEnvio) => (
                  <tr key={f.id} className="border-t align-top">
                    <td className="p-3">{ROTULO_DO_PROVIDER[f.provider]}</td>
                    <td className="p-3">{f.eventType ? t(ROTULO_DO_TIPO[f.eventType]) : (f.eventName ?? "—")}</td>
                    <td className="p-3">
                      <Badge cor={COR_DO_STATUS_DE_ENVIO[f.status]}>
                        {t(ROTULO_DO_STATUS_DE_ENVIO[f.status])}
                      </Badge>
                    </td>
                    <td className="p-3 tabular-nums">{f.attemptCount}</td>
                    <td className="p-3 whitespace-nowrap text-muted-foreground">
                      {f.lastAttemptAt ? new Date(f.lastAttemptAt).toLocaleString(idioma) : "—"}
                    </td>
                    <td className="p-3 whitespace-nowrap text-muted-foreground">
                      {f.nextRetryAt ? new Date(f.nextRetryAt).toLocaleString(idioma) : "—"}
                    </td>
                    <td className="max-w-xs p-3 text-xs text-muted-foreground">
                      {f.errorMessage ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Secao>

      {/* (c) Logs de envio por plataforma */}
      <Secao
        id="c_status"
        titulo={t("Logs de envio por plataforma")}
        descricao={t("Histórico bruto de cada tentativa de chamada à API — sanitizado, sem segredo nenhum.")}
        chips={
          <>
            <Chip ativo={!cStatus} href={hrefComFiltro(filtros, "c_status", null)}>
              {t("Todos")}
            </Chip>
            <Chip ativo={cStatus === "ok"} href={hrefComFiltro(filtros, "c_status", "ok")}>
              {t("ok")}
            </Chip>
            <Chip ativo={cStatus === "erro"} href={hrefComFiltro(filtros, "c_status", "erro")}>
              {t("erro")}
            </Chip>
          </>
        }
      >
        {logs.length === 0 ? (
          <TabelaVazia texto={t("Nenhuma tentativa registrada com este filtro.")} />
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-3 font-medium">{t("Plataforma")}</th>
                  <th className="p-3 font-medium">{t("Evento")}</th>
                  <th className="p-3 font-medium">{t("Status")}</th>
                  <th className="p-3 font-medium">{t("Erro")}</th>
                  <th className="p-3 font-medium">{t("Quando")}</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l: LinhaDeLogDePlataforma) => (
                  <tr key={l.id} className="border-t align-top">
                    <td className="p-3">{ROTULO_DO_PROVIDER[l.provider]}</td>
                    <td className="p-3">{l.eventName ?? "—"}</td>
                    <td className="p-3">
                      <Badge cor={COR_DO_STATUS_DO_LOG[l.status]}>{t(l.status)}</Badge>
                    </td>
                    <td className="max-w-xs p-3 text-xs text-muted-foreground">
                      {l.errorMessage ?? "—"}
                    </td>
                    <td className="p-3 whitespace-nowrap text-muted-foreground">
                      {new Date(l.attemptedAt).toLocaleString(idioma)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Secao>

      {/* (d) Ações administrativas */}
      <Secao
        id="d_acao"
        titulo={t("Ações administrativas")}
        descricao={t(
          "Usuário criado, papel alterado, integração reconfigurada, lead criado manualmente vs. via tracking.",
        )}
        chips={
          <>
            <Chip ativo={!acao} href={hrefComFiltro(filtros, "d_acao", null)}>
              {t("Todas")}
            </Chip>
            {acoesDistintas.map((a) => (
              <Chip key={a} ativo={acao === a} href={hrefComFiltro(filtros, "d_acao", a)}>
                {a}
              </Chip>
            ))}
          </>
        }
      >
        {acoes.length === 0 ? (
          <TabelaVazia texto={t("Nenhuma ação administrativa registrada com este filtro.")} />
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="p-3 font-medium">{t("Ação")}</th>
                  <th className="p-3 font-medium">{t("Quem")}</th>
                  <th className="p-3 font-medium">{t("Recurso")}</th>
                  <th className="p-3 font-medium">{t("Quando")}</th>
                </tr>
              </thead>
              <tbody>
                {acoes.map((a: LinhaDeAcaoAdministrativa) => (
                  <tr key={a.id} className="border-t align-top">
                    <td className="p-3 font-mono text-xs">{a.action}</td>
                    <td className="p-3 font-mono text-xs text-muted-foreground">
                      {a.actorUserId ?? t("(sistema)")}
                    </td>
                    <td className="p-3 text-xs text-muted-foreground">
                      {a.resourceType ? `${a.resourceType}${a.resourceId ? ` · ${a.resourceId}` : ""}` : "—"}
                    </td>
                    <td className="p-3 whitespace-nowrap text-muted-foreground">
                      {new Date(a.createdAt).toLocaleString(idioma)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Secao>
    </div>
  );
}
