/**
 * TenantOverview — o cartão que o admin de plataforma lê sobre um tenant.
 *
 * O defeito guardado aqui é de SAÍDA VISÍVEL: a tela comparava o status da
 * integração com `"active"`, valor que `tenant_integrations_status_check` não
 * admite. A integração saudável que o callback do OAuth grava (`healthy`) caía
 * no ramo final, e o admin lia a string crua do banco num badge de alerta —
 * enquanto `token_expired`, o estado que exige ação, era inalcançável por
 * construção.
 *
 * Dois níveis de guarda, de propósito:
 *  - os casos nomeados, que fixam o que o admin lê (rótulo + variante);
 *  - a cobertura contra o CHECK do `supabase/baseline.sql` — o arquivo que o
 *    self-hoster realmente aplica. Migration que acrescente um status ao banco
 *    sem atualizar os mapas da tela reprova aqui, que é exatamente o modo de
 *    falha que produziu este bug (o TypeScript não enxerga o CHECK).
 */
import { describe, expect, it } from "vitest";
import { render, within } from "@testing-library/react";

import { badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { valoresDoCheckNoBaseline } from "@/tests/helpers/baseline-check";
import type { TenantAgentSummary, TenantCounts, TenantOrganization } from "@/hooks/useTenantDetail";

import {
  NUVEMSHOP_LABEL,
  NUVEMSHOP_VARIANT,
  TenantOverview,
} from "./TenantOverview";

/**
 * Vocabulário que o banco aceita, lido do baseline. A leitura (e o "falha alto
 * em vez de devolver lista vazia") mora em `tests/helpers/baseline-check.ts`,
 * compartilhada com a rota que alimenta esta tela: dois leitores escritos à mão
 * seriam a duplicação contra a qual esta guarda existe.
 */
const STATUS_NO_BANCO = valoresDoCheckNoBaseline(
  "tenant_integrations_status_check",
);

const ORG: TenantOrganization = {
  id: "33333333-3333-4333-8333-333333333333",
  slug: "acme",
  display_name: "Acme",
  legal_name: "Acme Comércio LTDA",
  cnpj: "00.000.000/0001-00",
  status: "active",
  onboarded_at: "2026-01-02T12:00:00.000Z",
  suspended_at: null,
  created_at: "2026-01-01T12:00:00.000Z",
  settings: { plan: "pro" },
};

const COUNTS: TenantCounts = {
  user_count: 3,
  conversations_count: 10,
  messages_count: 100,
  leads_count: 5,
  orders_count: 2,
  lgpd_requests_pending: 0,
  ai_invocations_30d: 42,
  waha_sessions_count: 1,
};

/**
 * O badge que a linha "Nuvemshop" exibe — o pedaço de tela em disputa.
 *
 * Ancora no rótulo da linha (e não numa classe) porque há outro badge no
 * cartão, o do plano. Se a marcação mudar a ponto de a linha não ter badge,
 * estoura em vez de devolver um elemento qualquer.
 */
function badgeNuvemshop(status: string | null): HTMLElement {
  const { container } = render(
    <TenantOverview
      organization={ORG}
      counts={COUNTS}
      integrations={{ nuvemshop_status: status, nuvemshop_connected_at: null }}
      agents={[]}
    />,
  );
  const badge = within(container).getByText("Nuvemshop").nextElementSibling
    ?.firstElementChild;
  if (!(badge instanceof HTMLElement)) {
    throw new Error("a linha 'Nuvemshop' não renderizou um badge");
  }
  return badge;
}

/** Classe que o `Badge` produz para uma variante — evita fixar tokens do tema. */
function classeDaVariante(
  variante: "success" | "warning" | "error" | "neutral",
): string {
  return cn(badgeVariants({ variant: variante }));
}

describe("TenantOverview — status da Nuvemshop", () => {
  it("integração saudável lê 'Conectado', não a string do banco", () => {
    const badge = badgeNuvemshop("healthy");
    expect(badge).toHaveTextContent("Conectado");
    expect(badge.textContent).not.toContain("healthy");
    expect(badge.className).toBe(classeDaVariante("success"));
  });

  it("token vencido é erro visível, o ramo que era inalcançável", () => {
    const badge = badgeNuvemshop("token_expired");
    expect(badge).toHaveTextContent("Token expirado");
    expect(badge.className).toBe(classeDaVariante("error"));
    // Antes do conserto, TODO status conhecido caía no ramo final e saía com
    // cara de alerta genérico.
    expect(badge.className).not.toBe(classeDaVariante("warning"));
  });

  it("tenant sem integração diz 'Não integrado' em tom neutro", () => {
    const badge = badgeNuvemshop(null);
    expect(badge).toHaveTextContent("Não integrado");
    expect(badge.className).toBe(classeDaVariante("neutral"));
  });

  it("nenhum status que o banco aceita vaza cru para a tela", () => {
    for (const status of STATUS_NO_BANCO) {
      const texto = (badgeNuvemshop(status).textContent ?? "").trim();
      expect(texto, `status '${status}' sem rótulo em NUVEMSHOP_LABEL`).not.toBe(
        status,
      );
      expect(texto.length).toBeGreaterThan(0);
    }
  });

  it("os mapas cobrem o CHECK do banco — rótulo E variante", () => {
    // Rótulo e variante são mapas independentes: um status com rótulo e sem
    // variante sai com o fallback de alerta, e isso não aparece no texto.
    for (const status of STATUS_NO_BANCO) {
      expect(Object.keys(NUVEMSHOP_LABEL)).toContain(status);
      expect(Object.keys(NUVEMSHOP_VARIANT)).toContain(status);
    }
  });

  it("status fora do vocabulário aparece cru, mas nunca com cara de saudável", () => {
    // Exibir o valor desconhecido é decisão registrada no componente: esconder
    // um estado que a tela não sabe nomear é pior que mostrá-lo. O ramo é
    // inalcançável para qualquer valor real — quem garante isso é o teste de
    // cobertura acima. O que ele não pode é ler como "tudo certo".
    const badge = badgeNuvemshop("quota_exceeded");
    expect(badge).toHaveTextContent("quota_exceeded");
    expect(STATUS_NO_BANCO).not.toContain("quota_exceeded");
    expect(badge.className).not.toBe(classeDaVariante("success"));
  });
});

/**
 * TenantOverview — "qual agente está publicado" (item novo do painel de
 * plataforma). Antes não existia NENHUMA tela de admin mostrando isso: o único
 * jeito de saber qual modelo um tenant tinha em produção era consultar o banco
 * direto.
 */
describe("TenantOverview — agentes de IA", () => {
  function renderComAgentes(agents: TenantAgentSummary[]) {
    return render(
      <TenantOverview
        organization={ORG}
        counts={COUNTS}
        integrations={{ nuvemshop_status: null, nuvemshop_connected_at: null }}
        agents={agents}
      />,
    );
  }

  it("⭐ agente publicado mostra 'Publicado' e o modelo da VERSÃO, não o rascunho", () => {
    const { getByText } = renderComAgentes([
      {
        id: "a1",
        name: "SDR",
        kind: "mcp_agent",
        status: "no_ar",
        model: "openai/gpt-5.6-terra",
        version_number: 3,
        published_at: "2026-09-10T12:00:00.000Z",
      },
    ]);
    expect(getByText("Publicado")).toBeInTheDocument();
    expect(getByText("openai/gpt-5.6-terra")).toBeInTheDocument();
    expect(getByText("v3")).toBeInTheDocument();
  });

  it("agente sem publicação mostra 'Rascunho' e NÃO mostra modelo/versão", () => {
    const { getByText, queryByText } = renderComAgentes([
      {
        id: "a2",
        name: "Atendimento",
        kind: "rag_bot",
        status: "parado",
        model: "openai/gpt-5.6-terra",
        version_number: null,
        published_at: null,
      },
    ]);
    expect(getByText("Rascunho")).toBeInTheDocument();
    // O modelo do RASCUNHO não é o que responde ao cliente — mostrá-lo junto de
    // "Rascunho" faria o admin achar que aquele modelo está em produção.
    expect(queryByText("openai/gpt-5.6-terra")).not.toBeInTheDocument();
  });

  it("sem nenhum agente, mostra o estado vazio explícito", () => {
    const { getByText } = renderComAgentes([]);
    expect(getByText("Nenhum agente cadastrado.")).toBeInTheDocument();
  });

  it("vários agentes: cada um com seu próprio nome e status", () => {
    const { getByText } = renderComAgentes([
      {
        id: "a1",
        name: "SDR",
        kind: "mcp_agent",
        status: "no_ar",
        model: "openai/gpt-5.6-terra",
        version_number: 1,
        published_at: "2026-09-01T00:00:00.000Z",
      },
      {
        id: "a2",
        name: "Suporte",
        kind: "mcp_agent",
        status: "parado",
        model: "openai/gpt-5.6-terra",
        version_number: null,
        published_at: null,
      },
    ]);
    expect(getByText("SDR")).toBeInTheDocument();
    expect(getByText("Suporte")).toBeInTheDocument();
  });
});
