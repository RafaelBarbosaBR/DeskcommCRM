/**
 * O PEDIDO PENDENTE QUE NINGUÉM CONFIRMOU (Onda 4.5).
 *
 * `requires_confirmation` faz o compromisso nascer `pending` — e nada nunca
 * o tirava de lá. `LIBERAM_O_HORARIO` (`lib/agenda/ocupados.ts`) trata
 * `pending` como ocupação de verdade (de propósito: dois pedidos não podem
 * cair no mesmo instante), então um pedido esquecido segurava o horário PARA
 * SEMPRE — ninguém mais conseguia marcar ali, e o cliente que desistiu nunca
 * soube que "reservou" nada.
 *
 * ═══ QUEM EXPIRA É A RESERVA, NÃO O PEDIDO NA FILA ═══
 *
 * Cancelar não bane o cliente: ele pode pedir de nova o mesmo horário (se
 * ainda estiver livre) ou outro qualquer. O que expira é ESTE compromisso
 * específico, que parou de significar "alguém está esperando confirmação" e
 * passou a significar "um horário morto no calendário de ninguém".
 *
 * ═══ SEM AVISAR O CLIENTE, POR PADRÃO ═══
 *
 * Este cron não manda mensagem nenhuma — ele só CANCELA
 * (`cancelarAgendamentoHandler`, a MESMA função que a tela e o agente usam),
 * e cancelar já emite `agenda.appointment_cancelled` como evento de
 * automação (Onda 4.1). Uma organização que configurou uma regra "avisar
 * quando cancelar" É avisada, pela escolha DELA; a que não configurou nada
 * fica em silêncio, que é o comportamento padrão pedido.
 *
 * ═══ POR QUE REUSAR O HANDLER, E NÃO UM UPDATE CRU ═══
 *
 * `cancelarAgendamentoHandler` já resolve revisão (`alteraComRevisao`),
 * emite a atividade de timeline, o gatilho de automação e o próprio audit —
 * escrever um UPDATE direto aqui duplicaria essa decisão inteira num
 * segundo lugar, e é exatamente a classe de divergência que este repositório
 * já pagou (`horariosLivresDaOrg`/`exigeHorarioLivre`, mesmo raciocínio).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { cancelarAgendamentoHandler } from "@/app/api/v1/agenda/agendamentos/_handler";
import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Teto de compromissos examinados por rodada — defesa, não expectativa real. */
const LIMITE_DA_VARREDURA = 200;

/**
 * O prazo MÍNIMO que o CHECK do banco permite (`pending_expiration_hours >
 * 0`) — o corte grosseiro da consulta. O corte FINO, que depende do prazo
 * de CADA tipo, é `estaVencido`, em memória (mesmo desenho de `estaNaHora`
 * em `agenda-reminder`).
 */
const MENOR_PRAZO_POSSIVEL_MS = 1 * 60 * 60_000;

const RAZAO_DA_EXPIRACAO =
  "Pedido de horário não confirmado dentro do prazo — cancelado automaticamente.";

interface TipoDoCompromisso {
  pending_expiration_hours: number;
}

interface CompromissoPendente {
  id: string;
  organization_id: string;
  created_at: string;
  calendar_event_types: TipoDoCompromisso | TipoDoCompromisso[] | null;
}

/** O join do PostgREST devolve objeto ou array conforme a cardinalidade inferida. */
function tipoDe(linha: CompromissoPendente): TipoDoCompromisso | null {
  const t = linha.calendar_event_types;
  if (!t) return null;
  return Array.isArray(t) ? (t[0] ?? null) : t;
}

/**
 * Já passou do prazo? Pura e exportada — a mesma razão de `estaNaHora`
 * (`agenda-reminder`): é a regra que o teste precisa exercitar sem banco.
 */
export function estaVencido(agora: Date, criadoEm: Date, prazoHoras: number): boolean {
  return criadoEm.getTime() + prazoHoras * 60 * 60_000 <= agora.getTime();
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const fornecido = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const aceitos = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (aceitos.length === 0 || !fornecido || !aceitos.includes(fornecido)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const agora = new Date();

  // `!inner`: só interessa compromisso cujo TIPO existe (não deveria haver
  // órfão, mas o join `!inner` é o que faz o corte grosseiro de tempo abaixo
  // já vir junto com o prazo do tipo, sem uma segunda consulta por linha).
  const { data, error } = await admin
    .from("calendar_appointments")
    .select("id, organization_id, created_at, calendar_event_types!inner(pending_expiration_hours)")
    .eq("status", "pending")
    .lte("created_at", new Date(agora.getTime() - MENOR_PRAZO_POSSIVEL_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(LIMITE_DA_VARREDURA);

  if (error) {
    logger.error("[agenda-pending-expirer] consulta falhou", { error: error.message, requestId });
    return fail("internal_error", "Falha ao buscar compromissos pendentes.", 500, { requestId });
  }

  const linhas = (data ?? []) as unknown as CompromissoPendente[];
  let cancelados = 0;
  let pulados = 0;
  const motivos: Record<string, number> = {};
  const pular = (motivo: string) => {
    pulados += 1;
    motivos[motivo] = (motivos[motivo] ?? 0) + 1;
  };

  for (const linha of linhas) {
    const tipo = tipoDe(linha);
    if (!tipo) {
      pular("sem_tipo");
      continue;
    }
    if (!estaVencido(agora, new Date(linha.created_at), tipo.pending_expiration_hours)) {
      pular("ainda_dentro_do_prazo");
      continue;
    }

    try {
      // `webhook_source`: o mesmo ator que `agenda-reminder` usa para
      // mutação nascida de worker — `autorParaTimeline` mapeia para
      // `system` na atividade, que é a leitura honesta ("o sistema
      // cancelou", não "um atendente cancelou").
      await cancelarAgendamentoHandler(
        admin,
        {
          organization_id: linha.organization_id,
          actor: { type: "webhook_source", id: linha.id },
          requestId: `agenda-pending-expirer:${linha.id}`,
        },
        { id: linha.id, reason: RAZAO_DA_EXPIRACAO },
      );
      cancelados += 1;
    } catch (err) {
      const mensagem = err instanceof Error ? err.message : String(err);
      logger.error("[agenda-pending-expirer] cancelamento falhou", {
        appointmentId: linha.id,
        error: mensagem,
        requestId,
      });
      pular("erro_no_cancelamento");
    }
  }

  // Cada cancelamento já audita por conta própria
  // (`cancelarAgendamentoHandler` → `agenda.appointment_cancelled`) — uma
  // segunda linha de audit aqui só duplicaria o rastro, sem contar nada novo.
  return ok({ examinados: linhas.length, cancelados, pulados, motivos }, { requestId });
}

export const GET = handle;
export const POST = handle;
