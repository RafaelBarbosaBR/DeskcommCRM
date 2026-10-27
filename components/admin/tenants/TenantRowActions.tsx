"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Eye, Pause, PencilSimple, Play, Receipt } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import type { AdminTenantRow } from "@/hooks/useAdminTenants";
import { SuspendDialog } from "./SuspendDialog";
import { ReactivateDialog } from "./ReactivateDialog";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TenantRowActionsProps {
  row: AdminTenantRow;
}

// ---------------------------------------------------------------------------
// Componente
// ---------------------------------------------------------------------------

/**
 * Os três atalhos da linha da listagem (#2778) — um clique, sem abrir o tenant.
 *
 * A assimetria é de PROPÓSITO, não de implementação:
 *
 *  - **Acompanhar** e **Editar** são leituras/formulários que não cabem numa
 *    linha, então NAVEGAM (`Link`, com `href` conferível) — a saúde fica em
 *    `/health` e a edição na própria ficha do tenant.
 *  - **Suspender/Reativar** é a suspensão ADMINISTRATIVA, reversível, então
 *    acontece AQUI, com diálogo de confirmação mostrando o `display_name` e sem
 *    navegar: a posição na lista é preservada.
 *
 * O terceiro botão LÊ o `status` que a linha já traz — é o defeito que a issue
 * aponta como "o único risco real". `suspended` vira **Reativar** — exceto a
 * suspensão por falta de pagamento (`suspended_kind === "cobranca"`), que a
 * rota `/reactivate` recusa com 409: ali o atalho leva à ficha, onde o card
 * Cobrança dá prazo ou torna isenta (a mesma regra de `TenantActions`).
 * `redacted` não mostra nenhum dos três — um tenant anonimizado não tem dados
 * para editar nem organização para acompanhar —, só o link para a ficha, que
 * continua sendo a única porta para ele.
 *
 * Guard de permissão NÃO é daqui: toda a tela já roda sob `requirePlatformAdmin`.
 */
export function TenantRowActions({ row }: TenantRowActionsProps) {
  const t = useT();
  const [dialogo, setDialogo] = useState<null | "suspender" | "reativar">(null);

  // Depois dos hooks, sempre: a regra do React não muda porque a linha não
  // tenha ações a oferecer.
  if (row.status === "redacted") {
    return (
      <div className="flex justify-end">
        <Link
          href={`/admin/tenants/${row.id}`}
          className="text-xs font-medium text-accent hover:underline"
        >
          {t("Ver")}
        </Link>
      </div>
    );
  }

  const nome = row.display_name;
  const suspenso = row.status === "suspended";
  const porCobranca = suspenso && row.suspended_kind === "cobranca";
  // Chaves com `{nome}` (o padrão do repo: `t()` traduz, `.replace()` cola o
  // dado) — o rótulo precisa dizer QUEM, numa lista de 30 linhas iguais.
  const saude = t("Acompanhar a saúde de {nome}").replace("{nome}", nome);
  const edicao = t("Editar os dados de {nome}").replace("{nome}", nome);
  // Mesmo espaço na linha, rótulo que muda com o estado: suspender um tenant já
  // suspenso (ou reativar um ativo) é o defeito que esta linha existe para
  // impedir. "Reativar" é chave solta, do dicionário, e devolve "Reativar X".
  const ciclo = suspenso
    ? `${t("Reativar")} ${nome}`
    : t("Suspender {nome}").replace("{nome}", nome);

  return (
    <>
      <div className="flex items-center justify-end gap-0.5">
        <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
          <Link
            href={`/admin/tenants/${row.id}/health`}
            title={saude}
            aria-label={saude}
          >
            <Eye size={16} weight="regular" aria-hidden />
          </Link>
        </Button>

        <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
          <Link
            href={`/admin/tenants/${row.id}`}
            title={edicao}
            aria-label={edicao}
          >
            <PencilSimple size={16} weight="regular" aria-hidden />
          </Link>
        </Button>

        {porCobranca ? (
          <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
            <Link
              href={`/admin/tenants/${row.id}`}
              title={`${t("Suspensa por falta de pagamento")} — ${nome}`}
              aria-label={`${t("Suspensa por falta de pagamento")} — ${nome}`}
            >
              <Receipt size={16} weight="regular" aria-hidden />
            </Link>
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className={
              suspenso ? "h-8 w-8" : "h-8 w-8 text-muted-foreground hover:text-destructive"
            }
            title={ciclo}
            aria-label={ciclo}
            onClick={() => setDialogo(suspenso ? "reativar" : "suspender")}
          >
            {suspenso ? (
              <Play size={16} weight="regular" aria-hidden />
            ) : (
              <Pause size={16} weight="regular" aria-hidden />
            )}
          </Button>
        )}
      </div>

      {/* O MESMO diálogo da ficha do tenant, sem formulário novo: a lista já é
          invalidada pelos hooks de suspensão/reativação. Montado só quando
          aberto — trinta linhas × dois diálogos montados seria sessenta
          mutações de react-query vivendo em toda carga da listagem, e os dois
          hooks exigem o QueryClient do provedor. */}
      {dialogo === "suspender" && (
        <SuspendDialog
          open
          onClose={() => setDialogo(null)}
          organizationId={row.id}
          displayName={nome}
        />
      )}
      {dialogo === "reativar" && (
        <ReactivateDialog
          open
          onClose={() => setDialogo(null)}
          organizationId={row.id}
          displayName={nome}
        />
      )}
    </>
  );
}
