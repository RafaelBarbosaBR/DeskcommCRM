"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { useT } from "@/hooks/i18n/useT";
import { regenerateMetaVerifyToken } from "@/app/actions/settings/regenerateMetaVerifyToken";
import { updateMetaApp } from "@/app/actions/settings/updateMetaApp";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { FonteDoCampo } from "@/lib/channels/meta/platform-app";

interface Props {
  readonly appSecretConfigurado: boolean;
  readonly appSecretFonte: FonteDoCampo;
  readonly verifyTokenConfigurado: boolean;
  readonly verifyTokenFonte: FonteDoCampo;
  readonly atualizadoEm: string | null;
}

const ROTULO_DA_FONTE: Record<FonteDoCampo, string> = {
  table: "cadastrado por aqui",
  env: "vindo do arquivo de configuração do servidor (.env)",
  none: "não configurado",
};

export function FormularioDoAppDaMeta({
  appSecretConfigurado,
  appSecretFonte,
  verifyTokenConfigurado,
  verifyTokenFonte,
  atualizadoEm,
}: Props) {
  const t = useT();
  const router = useRouter();
  const [appSecret, setAppSecret] = useState("");
  const [salvandoSecret, iniciarSalvarSecret] = useTransition();
  const [gerandoToken, iniciarGerarToken] = useTransition();
  // O valor SÓ existe em memória do componente, nesta sessão de tela — sai
  // no reload, e nenhuma leitura posterior devolve ele de volta (ver
  // `platformMetaAppStatus`, que só expõe `configured`/`source`).
  const [tokenRecemGerado, setTokenRecemGerado] = useState<string | null>(null);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("App da Meta desta instalação")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Com estas duas informações, o canal oficial do WhatsApp (WhatsApp Cloud API) consegue receber mensagem de qualquer organização desta instalação. Elas valem para a instalação inteira — o app é o da PLATAFORMA, não o de um cliente.")}
        </p>
      </header>

      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="app-secret">{t("App Secret")}</Label>
          <Input
            id="app-secret"
            data-testid="meta-app-secret"
            type="password"
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            placeholder={appSecretConfigurado ? "••••••••  (já cadastrado)" : "…"}
          />
          <p className="text-xs text-muted-foreground">
            {appSecretConfigurado
              ? t("Já existe um App Secret em vigor — ") + t(ROTULO_DA_FONTE[appSecretFonte]) + t(". Deixe em branco para mantê-lo, ou digite um novo para substituir.")
              : t("Ele é guardado cifrado e nunca volta a aparecer nesta tela.")}
          </p>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {atualizadoEm ? `${t("Última alteração em")} ${atualizadoEm}.` : t("Nunca configurado por aqui.")}
          </span>
          <Button
            data-testid="meta-app-salvar-secret"
            disabled={!appSecret.trim() || salvandoSecret}
            onClick={() =>
              iniciarSalvarSecret(async () => {
                const r = await updateMetaApp({ app_secret: appSecret.trim() });
                if (!r.ok) {
                  toast.error(t(r.error));
                  return;
                }
                toast.success(t("App Secret salvo."));
                setAppSecret("");
                router.refresh();
              })
            }
          >
            {salvandoSecret ? t("Salvando…") : t("Salvar")}
          </Button>
        </div>
      </Card>

      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1.5">
          <Label>{t("Verify token")}</Label>
          <p className="text-xs text-muted-foreground">
            {t("É o valor que a Meta pede ao configurar o endereço do webhook — cole-o no dashboard dela como \"Verify Token\". Diferente do App Secret, ele só valida esse cadastro inicial; não é usado para assinar mensagens.")}
          </p>
        </div>

        {tokenRecemGerado ? (
          <div
            data-testid="meta-verify-token-novo"
            className="rounded-md border border-warning/40 bg-warning-bg p-3"
          >
            <p className="text-xs font-semibold text-text">
              {t("Copie agora — ele não vai aparecer de novo nesta tela:")}
            </p>
            <code className="mt-1.5 block break-all rounded-sm bg-surface px-2 py-1.5 text-xs">
              {tokenRecemGerado}
            </code>
          </div>
        ) : (
          <p
            data-testid="meta-verify-token-status"
            className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground"
          >
            {verifyTokenConfigurado
              ? t("Já existe um verify token em vigor — ") + t(ROTULO_DA_FONTE[verifyTokenFonte]) + "."
              : t("Nenhum verify token configurado ainda — o webhook oficial não aceita ser cadastrado na Meta sem ele.")}
          </p>
        )}

        <div className="flex justify-end">
          <Button
            variant="outline"
            data-testid="meta-gerar-verify-token"
            disabled={gerandoToken}
            onClick={() =>
              iniciarGerarToken(async () => {
                const r = await regenerateMetaVerifyToken();
                if (!r.ok) {
                  toast.error(t(r.error));
                  return;
                }
                setTokenRecemGerado(r.webhook_verify_token);
                toast.success(t("Verify token gerado."));
                router.refresh();
              })
            }
          >
            {gerandoToken
              ? t("Gerando…")
              : verifyTokenConfigurado
                ? t("Regerar verify token")
                : t("Gerar verify token")}
          </Button>
        </div>

        {verifyTokenConfigurado && !tokenRecemGerado && (
          <p className="text-xs leading-4 text-warning">
            {t("Regerar invalida o cadastro atual na Meta — depois de gerar um novo, atualize o \"Verify Token\" no dashboard dela também, senão o handshake do webhook passa a falhar.")}
          </p>
        )}
      </Card>
    </div>
  );
}
