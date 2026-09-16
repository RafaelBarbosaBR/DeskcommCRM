/**
 * O ANIVERSÁRIO DO CONTATO — o gatilho de automação que faltava (Onda 4.4).
 *
 * `contacts.birthdate` já existia, sem NENHUM consumidor: cadastrar a data
 * não fazia nada além de guardar o dado. Este cron é o disparador — a MESMA
 * classe de anti-pattern nº 3 do CLAUDE.md que `agenda-reminder` fechou para
 * `reminder_enabled`.
 *
 * ⚠️ ESTE CRON NÃO MANDA MENSAGEM. Ele só EMITE `contact.birthday` em
 * `event_log` (via `emit_event`) — quem decide o que acontece é a
 * `automation_rule` que a organização configurou (mensagem, tag, mover no
 * funil…), pela MESMA cadeia que `lib/automation/engine.ts` já roda para os
 * outros gatilhos. Uma organização sem regra cadastrada para este evento não
 * manda nada, e é o comportamento CERTO — o motor decide, o cron só nota o
 * fato.
 *
 * ═══ POR QUE HORÁRIO É POR ORGANIZAÇÃO, NÃO GLOBAL ═══
 *
 * "9h" só quer dizer alguma coisa NO FUSO de quem recebe. Uma varredura em UTC
 * fixo (como `lgpd-sla-watcher`, `0 12 * * *`) acertaria 9h para UM fuso só e
 * mandaria de madrugada — ou no dia errado — para o resto. Este cron roda A
 * CADA HORA (`docker/scheduler/entrypoint.sh`) e decide, por organização, se
 * o relógio dela marca 9h AGORA (`partesNoFuso`, `lib/agenda/fuso.ts` — a
 * mesma conversão que a agenda já usa, sem reinventar fuso horário aqui).
 *
 * ═══ POR QUE NÃO DISPARA 2× ═══
 *
 * Uma organização só cai na janela de 9h UMA vez por dia (o relógio local
 * anda uma hora por hora, e o cron roda de hora em hora) — mas isso sozinho
 * não basta contra um cron retentado ou chamado à mão duas vezes na mesma
 * hora. A garantia de verdade é `event_log`: antes de emitir, a rodada lê
 * quais contatos JÁ RECEBERAM `contact.birthday` ESTE ANO LOCAL da
 * organização, e pula quem já está na lista. Sem coluna nova em `contacts` —
 * `event_log` já é o rastro de "isto já aconteceu", e é o mesmo raciocínio de
 * `avisarMidiaNaoLida` (dedupe por linha já aberta) aplicado a "já emitido".
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { instanteDe, partesNoFuso } from "@/lib/agenda/fuso";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** A hora local (0–23) em que o aniversário é anunciado. */
export const HORA_LOCAL_DO_AVISO = 9;

/**
 * O relógio DESTA organização marca a hora do aviso, AGORA?
 *
 * Pura e exportada — é a regra que o teste precisa exercitar sem banco, com
 * fusos de verdade: "9h" só quer dizer alguma coisa NO FUSO de quem recebe, e
 * é esta função que decide isso, uma organização por vez. O cron roda de hora
 * em hora (`docker/scheduler/entrypoint.sh`), e cada organização só entra na
 * janela UMA vez por dia — o relógio local dela anda uma hora por tick.
 */
export function estaNaJanelaDoAviso(agora: Date, timezone: string): boolean {
  return partesNoFuso(agora, timezone).hora === HORA_LOCAL_DO_AVISO;
}

/** Teto de organizações e de aniversariantes por organização, por rodada — defesa, não expectativa real. */
const LIMITE_DE_ORGANIZACOES = 500;
const LIMITE_DE_ANIVERSARIANTES_POR_ORG = 500;

interface OrganizacaoAtiva {
  id: string;
  timezone: string;
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

  const { data: orgsRaw, error: erroOrgs } = await admin
    .from("organizations")
    .select("id, timezone")
    .eq("status", "active")
    .limit(LIMITE_DE_ORGANIZACOES);
  if (erroOrgs) {
    logger.error("[contact-birthdays] consulta de organizações falhou", {
      error: erroOrgs.message,
      requestId,
    });
    return fail("internal_error", "Falha ao buscar organizações.", 500, { requestId });
  }

  const organizacoes = (orgsRaw ?? []) as OrganizacaoAtiva[];
  let organizacoesNaJanela = 0;
  let emitidos = 0;
  const motivos: Record<string, number> = {};
  const pular = (motivo: string) => {
    motivos[motivo] = (motivos[motivo] ?? 0) + 1;
  };

  for (const org of organizacoes) {
    // Só a organização cujo relógio marca 9h AGORA — ver `estaNaJanelaDoAviso`.
    if (!estaNaJanelaDoAviso(agora, org.timezone)) continue;
    organizacoesNaJanela += 1;
    const parede = partesNoFuso(agora, org.timezone);

    const { data: aniversariantesRaw, error: erroContatos } = await admin
      .rpc("fn_aniversariantes_do_dia", { p_org: org.id, p_mes: parede.mes, p_dia: parede.dia })
      .limit(LIMITE_DE_ANIVERSARIANTES_POR_ORG);
    if (erroContatos) {
      logger.error("[contact-birthdays] fn_aniversariantes_do_dia falhou", {
        organization_id: org.id,
        error: erroContatos.message,
        requestId,
      });
      pular("consulta_de_aniversariantes_falhou");
      continue;
    }

    const aniversariantes = (aniversariantesRaw ?? []) as Array<{ contact_id: string }>;
    if (aniversariantes.length === 0) continue;

    // O ANO LOCAL da organização — o corte de "já emitiu este ano" é medido
    // no fuso DELA, não em UTC. `instanteDe` (o mesmo conversor de
    // `horarios-livres.ts`) devolve o instante exato de 1º de janeiro local.
    const inicioDoAnoLocal = instanteDe({ ano: parede.ano, mes: 1, dia: 1 }, org.timezone);
    const { data: jaEmitidosRaw, error: erroEventLog } = await admin
      .from("event_log")
      .select("entity_id")
      .eq("organization_id", org.id)
      .eq("event_type", "contact.birthday")
      .gte("created_at", inicioDoAnoLocal.toISOString());
    if (erroEventLog) {
      logger.error("[contact-birthdays] leitura de event_log falhou", {
        organization_id: org.id,
        error: erroEventLog.message,
        requestId,
      });
      pular("leitura_de_event_log_falhou");
      continue;
    }
    const jaEmitidos = new Set((jaEmitidosRaw ?? []).map((l) => l.entity_id));

    for (const { contact_id: contactId } of aniversariantes) {
      if (jaEmitidos.has(contactId)) {
        pular("ja_emitido_este_ano");
        continue;
      }

      const { error: erroEmit } = await admin.rpc("emit_event", {
        p_event_type: "contact.birthday",
        p_entity_kind: "contact",
        p_entity_id: contactId,
        p_organization_id: org.id,
      });
      if (erroEmit) {
        logger.error("[contact-birthdays] emit_event falhou", {
          organization_id: org.id,
          contact_id: contactId,
          error: erroEmit.message,
          requestId,
        });
        pular("emit_event_falhou");
        continue;
      }
      emitidos += 1;
    }
  }

  // Rodada que não emitiu nada NÃO audita — mesma lei do CLAUDE.md §Audit log
  // que `agenda-reminder` já segue, vigiada por
  // `tests/unit/cron-audita-so-quando-ha-efeito.test.ts`.
  if (emitidos > 0) {
    await audit({
      action: "automation.contact_birthday_emitted",
      resourceType: "contact",
      requestId,
      metadata: { emitidos, organizacoes_na_janela: organizacoesNaJanela, motivos },
    });
  }

  return ok(
    { organizacoes_examinadas: organizacoes.length, organizacoes_na_janela: organizacoesNaJanela, emitidos, motivos },
    { requestId },
  );
}

export const GET = handle;
export const POST = handle;
