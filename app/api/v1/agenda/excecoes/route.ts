import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * EXCEÇÕES DE DISPONIBILIDADE — fechar um dia (feriado/férias) ou abrir um
 * excepcionalmente (o sábado especial).
 *
 * `calendar_availability_exceptions` (migration 0177) e `janelasDoDia`
 * (lib/agenda/horarios-livres.ts) já sabiam ler isto — o motor de horários
 * livres trata `is_unavailable`/`start_minute`/`end_minute` desde sempre.
 * Faltava só a porta: nenhuma rota criava, listava ou removia uma linha.
 *
 * Escopo desta rota: SEMPRE a própria pessoa (`user_id = auth.uid()`, nunca
 * do corpo). A RLS de escrita (`calendar_availability_exceptions_write`)
 * também aceita manager+ editando OUTRO responsável, mas esta rota não expõe
 * esse caminho ainda — fechar a própria agenda é o caso que motivou o item;
 * gerenciar a agenda de terceiros fica para quando alguém pedir.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const DATA_LOCAL = /^\d{4}-\d{2}-\d{2}$/;

const criarSchema = z
  .object({
    exception_date: z.string().regex(DATA_LOCAL, "Use o formato AAAA-MM-DD."),
    is_unavailable: z.boolean().optional().default(true),
    // O CHECK do banco é `start_minute >= 0 and end_minute <= 1440 and
    // end_minute > start_minute` — os mesmos limites aqui, para a recusa
    // chegar como 422 com o campo, não como 500 de constraint.
    start_minute: z.number().int().min(0).max(1439).optional().default(0),
    end_minute: z.number().int().min(1).max(1440).optional().default(1440),
    reason: z.string().trim().max(200).nullish(),
  })
  .refine((c) => c.end_minute > c.start_minute, {
    message: "O fim precisa vir depois do início.",
    path: ["end_minute"],
  });

const removerSchema = z.object({ id: z.string().uuid() });

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const autorizado = await requireRole("viewer", { requestId, resource: "calendar_availability_exceptions" });
  if (!autorizado.ok) return autorizado.response;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("calendar_availability_exceptions")
    .select("id, exception_date, is_unavailable, start_minute, end_minute, reason")
    .eq("organization_id", autorizado.org.orgId)
    .eq("user_id", autorizado.user.id)
    .order("exception_date", { ascending: true });

  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = req.headers.get("x-request-id") ?? undefined;
  const autorizado = await requireRole("agent", { requestId, resource: "calendar_availability_exceptions" });
  if (!autorizado.ok) return autorizado.response;
  const t = (texto: string) => traduzir(texto, autorizado.user.idioma);

  const lido = criarSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", t(lido.error.issues[0]?.message ?? "corpo inválido"), 422, { requestId });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("calendar_availability_exceptions")
    .insert({
      organization_id: autorizado.org.orgId,
      user_id: autorizado.user.id,
      exception_date: lido.data.exception_date,
      is_unavailable: lido.data.is_unavailable,
      start_minute: lido.data.start_minute,
      end_minute: lido.data.end_minute,
      reason: lido.data.reason ?? null,
    })
    .select("id, exception_date, is_unavailable, start_minute, end_minute, reason")
    .single();

  if (error) {
    // 23505 é a UNIQUE (organization_id, user_id, exception_date, start_minute).
    if (error.code === "23505") {
      return fail("conflict", t("Já existe uma exceção para este dia e horário."), 409, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  await audit({
    actorUserId: autorizado.user.id,
    action: "agenda.excecao_criada",
    organizationId: autorizado.org.orgId,
    resourceType: "calendar_availability_exceptions",
    resourceId: data.id,
    metadata: { data: lido.data.exception_date, indisponivel: lido.data.is_unavailable },
  });
  return ok(data, { requestId, status: 201 });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = req.headers.get("x-request-id") ?? undefined;
  const autorizado = await requireRole("agent", { requestId, resource: "calendar_availability_exceptions" });
  if (!autorizado.ok) return autorizado.response;
  const t = (texto: string) => traduzir(texto, autorizado.user.idioma);

  const lido = removerSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) return fail("validation_failed", t("corpo inválido"), 422, { requestId });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("calendar_availability_exceptions")
    .delete()
    .eq("id", lido.data.id)
    .eq("organization_id", autorizado.org.orgId)
    .eq("user_id", autorizado.user.id)
    .select("id")
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", t("Exceção não encontrada."), 404, { requestId });

  await audit({
    actorUserId: autorizado.user.id,
    action: "agenda.excecao_removida",
    organizationId: autorizado.org.orgId,
    resourceType: "calendar_availability_exceptions",
    resourceId: lido.data.id,
    metadata: {},
  });
  return ok(data, { requestId });
}
