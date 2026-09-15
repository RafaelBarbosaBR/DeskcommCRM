/**
 * GET/PUT /api/v1/voice/opt-in — os dois eixos de "chamada de voz ligada"
 * (ver `lib/voice/opt-in.ts`): a instalação oferece o serviço, e a
 * organização aceitou o risco. GET é `manager`+ (ver o estado); PUT é
 * `admin`+ (mudar a escolha da organização — a instalação não muda por aqui).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { instalacaoOfereceVoz } from "@/lib/voice/opt-in";
import { lerEscolhaDaOrg } from "@/lib/voice/guarda";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "voice_opt_in" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const db = await createClient();
  const oferece = instalacaoOfereceVoz();
  const escolha = oferece
    ? await lerEscolhaDaOrg(db, org.orgId)
    : { enabled: false, riscoAceitoEm: null, riscoAceitoPor: null };

  return ok(
    {
      instalacao_oferece: oferece,
      enabled: escolha.enabled,
      risco_aceito_em: escolha.riscoAceitoEm,
      risco_aceito_por: escolha.riscoAceitoPor,
    },
    { requestId },
  );
}

const bodySchema = z.object({ enabled: z.boolean() });

export async function PUT(req: Request): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "voice_opt_in" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  if (!instalacaoOfereceVoz()) {
    return fail(
      "voice_not_configured",
      t(
        "Esta instalação não tem o serviço de chamada de voz configurado. Peça a quem administra o servidor para configurá-lo.",
      ),
      503,
      { requestId },
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("invalid_body", t("Corpo inválido."), 400, { requestId });
  const { enabled } = parsed.data;

  const db = await createClient();
  const { error } = await db.from("org_voice_calls").upsert({
    organization_id: org.orgId,
    enabled,
    risco_aceito_em: enabled ? new Date().toISOString() : null,
    risco_aceito_por: enabled ? user.id : null,
  });
  if (error) return fail("save_failed", t("Não consegui salvar essa mudança agora."), 500, { requestId });

  await audit({
    action: enabled ? "voice.enabled" : "voice.disabled",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    requestId,
  });

  return ok({ enabled }, { requestId });
}
