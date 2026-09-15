"use server";

/**
 * O MODELO PADRÃO DA ORGANIZAÇÃO — o último degrau de `decidirBinding()`.
 *
 * `organizations.settings.llm.{provider,default_model}` já existe e já é LIDO
 * por todo ponto de IA que não tem binding próprio (`lib/ai/pontos/resolver.ts`,
 * tier `padrao_da_organizacao`) — inclusive `agent_turn`/`operator_turn`, os
 * dois únicos pontos que exigem ferramentas. Só não existia como GRAVAR: o
 * valor nascia do seed (`fn_seed_org_llm_defaults`) e ficava preso lá para
 * sempre, sem tela.
 *
 * ⚠️ SERVICE ROLE COM `organization_id` DE FONTE CONFIÁVEL — mesmo motivo de
 * `definirExigenciaDeMfa` (`politicaDeMfa.ts`): a única policy de escrita em
 * `organizations` é `orgs_write_platform_admin`, então pelo client de sessão um
 * admin de tenant casaria ZERO linhas e a tela diria "salvo" sobre nada. O id
 * vem de `resolveActiveOrg`, nunca do corpo.
 *
 * ⚠️ VALIDADO CONTRA O PONTO MAIS EXIGENTE QUE PODE HERDAR ESTE VALOR, não
 * contra um "ponto padrão" que não existe. `agent_turn` ("Responder o
 * cliente") exige `tools` E `imagem` — é o ponto onde um modelo incapaz de
 * function calling produz o pior desfecho do produto: o agente conversa
 * normalmente e não cria lead nem move funil, sem erro nenhum na tela (ver o
 * cabeçalho de `lib/ai/pontos/validar-binding.ts`). Reusar `validarBinding`
 * com `pontoId: "agent_turn"` dá essa garantia de graça, sem duplicar a regra.
 */
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { supportWriteError } from "@/lib/impersonate/support";
import { enxergaImagem } from "@/lib/ai/pontos/capacidade-em-vigor";
import { ehProvedorSuportado } from "@/lib/ai/pontos/provedores";
import { validarBinding } from "@/lib/ai/pontos/validar-binding";
import { createAdminClient } from "@/lib/supabase/admin";

export type ResultadoDoModeloPadrao =
  | { ok: true; avisos: string[] }
  | { ok: false; erro: string };

export async function atualizarModeloPadraoDaOrganizacao(
  provider: string,
  modelId: string,
): Promise<ResultadoDoModeloPadrao> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, erro: "Sua sessão expirou. Entre de novo." };
  if (supportWriteError(user.support)) {
    return { ok: false, erro: "Acompanhamento somente leitura ou encerrado." };
  }
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, erro: "Nenhuma empresa ativa." };
  if (org.role !== "admin") {
    return { ok: false, erro: "Só um administrador pode mudar o padrão da organização." };
  }

  if (!ehProvedorSuportado(provider)) {
    return {
      ok: false,
      erro: "Provedor não suportado por esta instalação — escolha um da lista em Agente de IA › Provedores.",
    };
  }
  const modeloLimpo = modelId.trim();
  if (!modeloLimpo) return { ok: false, erro: "Escolha um modelo." };

  const admin = createAdminClient();

  const { data: modelo } = await admin
    .from("ai_models")
    .select("model_id, supports_tools, supports_vision")
    .eq("provider", provider)
    .eq("model_id", modeloLimpo)
    .is("deprecated_at", null)
    .maybeSingle();

  const validacao = validarBinding({
    pontoId: "agent_turn",
    modelo: {
      model_id: modeloLimpo,
      supports_tools: modelo?.supports_tools ?? false,
      supports_vision: enxergaImagem({
        provider,
        modelId: modeloLimpo,
        doCatalogo: modelo?.supports_vision ?? null,
      }),
      conhecido: modelo !== null,
    },
  });
  if (!validacao.ok) return { ok: false, erro: validacao.mensagem };

  const { data: atual, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  if (erroLeitura) return { ok: false, erro: "Não consegui ler a configuração agora." };

  // `settings` é jsonb livre e compartilhado (marca, política de MFA moram no
  // mesmo objeto): ler, mesclar e gravar preserva o que não é nosso.
  const settings = (atual?.settings ?? {}) as Record<string, unknown>;
  const llm = (settings.llm ?? {}) as Record<string, unknown>;
  const novo = {
    ...settings,
    llm: { ...llm, provider, default_model: modeloLimpo },
  };

  const { error } = await admin.from("organizations").update({ settings: novo }).eq("id", org.orgId);
  if (error) return { ok: false, erro: "Não consegui salvar essa mudança agora." };

  await audit({
    action: "ai.purpose_binding_updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    // `escopo`, não `purpose`: "org_default" não é um PONTO que chama modelo
    // (`lib/ai/pontos/registro.ts`) — é a origem de fallback que outros pontos
    // usam quando não têm binding próprio (`decidirBinding()`). Uma chave
    // `purpose:` com literal aqui faria `tests/unit/pontos-de-ia-completude.
    // test.ts` (que varre o AST atrás de pontos ocultos) acusar um ponto que
    // não existe — o metadado é só rótulo de auditoria, nunca roteamento.
    metadata: { escopo: "org_default", provider, model_id: modeloLimpo },
  });

  // O gate/leitura de `decidirBinding` roda no servidor (a tela de Provedores
  // é `"use client"`, mas o GET que a alimenta lê `organizations.settings` a
  // cada carregamento — sem revalidar o layout, o próprio admin que acabou de
  // trocar veria o valor antigo até um refresh completo).
  revalidatePath("/app", "layout");
  return { ok: true, avisos: validacao.avisos };
}
