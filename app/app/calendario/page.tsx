import Link from "next/link";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { ROTULO_DO_STATUS, ROTULO_DO_TIPO, type StatusDeCompromisso } from "@/lib/leads/compromissos/tipos";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Calendário" };
export const dynamic = "force-dynamic";

interface LinhaDeCompromisso {
  id: string;
  type: keyof typeof ROTULO_DO_TIPO;
  title: string;
  scheduled_at: string;
  status: StatusDeCompromisso;
  assigned_to: string | null;
  lead_id: string;
  crm_leads: { title: string } | { title: string }[] | null;
}

/**
 * Visão agregada de TODOS os compromissos leves, de todos os leads — item 7
 * do pedido ("visão agregada /calendario, fora da tela do lead"). Deliberada-
 * mente separada de `/app/agenda` (o motor tipo Calendly, outra tabela,
 * outro problema) — ver decisão de arquitetura 10 do plano.
 */
export default async function CalendarioPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  const { status } = await searchParams;
  const statusFiltro: StatusDeCompromisso | null =
    status === "pending" || status === "completed" || status === "cancelled" ? status : null;

  const supabase = await createClient();
  let query = supabase
    .from("crm_lead_appointments")
    .select("id, type, title, scheduled_at, status, assigned_to, lead_id, crm_leads(title)")
    .eq("organization_id", activeOrg.orgId)
    .order("scheduled_at", { ascending: true })
    .limit(200);
  if (statusFiltro) query = query.eq("status", statusFiltro);
  else query = query.eq("status", "pending");

  const { data } = await query;
  const linhas = (data ?? []) as unknown as LinhaDeCompromisso[];

  const abas: { valor: string; rotulo: string }[] = [
    { valor: "pending", rotulo: t("Pendentes") },
    { valor: "completed", rotulo: t("Concluídos") },
    { valor: "cancelled", rotulo: t("Cancelados") },
  ];

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Calendário")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Compromissos de todos os negócios, num lugar só.")}
        </p>
      </header>

      <div className="flex gap-2 border-b border-border">
        {abas.map((aba) => (
          <Link
            key={aba.valor}
            href={`/app/calendario?status=${aba.valor}`}
            className={`border-b-2 px-3 py-2 text-sm ${
              (statusFiltro ?? "pending") === aba.valor
                ? "border-accent font-medium text-text"
                : "border-transparent text-muted-foreground hover:text-text"
            }`}
          >
            {aba.rotulo}
          </Link>
        ))}
      </div>

      {linhas.length === 0 ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          {t("Nada por aqui.")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="p-3 font-medium">{t("Quando")}</th>
                <th className="p-3 font-medium">{t("Tipo")}</th>
                <th className="p-3 font-medium">{t("Título")}</th>
                <th className="p-3 font-medium">{t("Negócio")}</th>
                <th className="p-3 font-medium">{t("Status")}</th>
              </tr>
            </thead>
            <tbody>
              {linhas.map((l) => {
                const lead = Array.isArray(l.crm_leads) ? l.crm_leads[0] : l.crm_leads;
                return (
                  <tr key={l.id} className="border-t align-top">
                    <td className="p-3 whitespace-nowrap text-muted-foreground">
                      {new Date(l.scheduled_at).toLocaleString(idioma)}
                    </td>
                    <td className="p-3">{t(ROTULO_DO_TIPO[l.type] ?? l.type)}</td>
                    <td className="p-3">{l.title}</td>
                    <td className="p-3">
                      <Link className="underline underline-offset-2" href={`/app/leads/${l.lead_id}`}>
                        {lead?.title ?? t("(sem título)")}
                      </Link>
                    </td>
                    <td className="p-3">{t(ROTULO_DO_STATUS[l.status])}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
