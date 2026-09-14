"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { updateTrackingGoogleAds } from "@/app/actions/settings/updateTrackingGoogleAds";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import type { EstadoDoProvider } from "@/lib/rastreamento/estado-da-conexao";

const ERRO_EM_PORTUGUES: Record<string, string> = {
  validation_failed: "Confira os campos: algum valor não está no formato esperado, ou falta um campo obrigatório na primeira conexão.",
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só um administrador da organização pode mudar esta conexão.",
  mfa_required: "Confirme o segundo fator para salvar esta mudança.",
  credencial_invalida: "O Google Ads recusou as credenciais. Confira developer token, client id/secret e refresh token.",
  cifra_indisponivel: "Esta instalação está sem a chave mestra de criptografia — quem instalou o sistema precisa configurá-la.",
  erro_ao_gravar: "Não consegui gravar agora. Tente de novo em instantes.",
};

export function FormularioDeGoogleAds({ estado, idioma }: { estado: EstadoDoProvider; idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const config = estado.config as {
    customer_id?: string;
    login_customer_id?: string | null;
    aw_conversion_id?: string | null;
    aw_contact_label?: string | null;
    conversion_action_map?: Record<string, string>;
  };

  const [customerId, setCustomerId] = useState(config.customer_id ?? "");
  const [loginCustomerId, setLoginCustomerId] = useState(config.login_customer_id ?? "");
  const [awConversionId, setAwConversionId] = useState(config.aw_conversion_id ?? "");
  const [awContactLabel, setAwContactLabel] = useState(config.aw_contact_label ?? "");
  const [actionLead, setActionLead] = useState(config.conversion_action_map?.Lead ?? "");
  const [actionQualified, setActionQualified] = useState(config.conversion_action_map?.Qualified ?? "");
  const [actionPurchase, setActionPurchase] = useState(config.conversion_action_map?.Purchase ?? "");
  const [developerToken, setDeveloperToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [habilitado, setHabilitado] = useState(estado.habilitado);

  const podeSalvar =
    /^\d{3}-?\d{3}-?\d{4}$/.test(customerId.trim()) &&
    (estado.temSegredo || (developerToken.trim() && clientId.trim() && clientSecret.trim() && refreshToken.trim()));

  function salvar(evento: React.FormEvent) {
    evento.preventDefault();
    startTransition(async () => {
      const resultado = await updateTrackingGoogleAds({
        customer_id: customerId.trim(),
        login_customer_id: loginCustomerId.trim() || null,
        aw_conversion_id: awConversionId.trim() || null,
        aw_contact_label: awContactLabel.trim() || null,
        conversion_action_lead: actionLead.trim() || null,
        conversion_action_qualified: actionQualified.trim() || null,
        conversion_action_purchase: actionPurchase.trim() || null,
        developer_token: developerToken.trim() || undefined,
        client_id: clientId.trim() || undefined,
        client_secret: clientSecret.trim() || undefined,
        refresh_token: refreshToken.trim() || undefined,
        enabled: habilitado,
      });
      if (resultado.ok) {
        setDeveloperToken(""); setClientId(""); setClientSecret(""); setRefreshToken("");
        toast.success(t("Google Ads conectado — testado contra a API."));
        router.refresh();
        return;
      }
      toast.error(t(ERRO_EM_PORTUGUES[resultado.error] ?? "Não consegui salvar agora."));
    });
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Google Ads</h3>
        {estado.conectado && (
          <span className={`rounded px-2 py-0.5 text-xs ${estado.habilitado ? "bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
            {estado.habilitado ? t("ativo") : t("pausado")}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("Contato dispara conversão client-side via gtag se houver AW-ID. Lead/qualificado/compra sobem via API — gclid quando existe, Enhanced Conversions (email/telefone) quando não.")}
      </p>
      <form onSubmit={salvar} className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="ga-customer-id">{t("Customer ID")}</Label>
            <Input id="ga-customer-id" value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder="123-456-7890" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="ga-login-customer-id">{t("Login customer ID (MCC, opcional)")}</Label>
            <Input id="ga-login-customer-id" value={loginCustomerId} onChange={(e) => setLoginCustomerId(e.target.value)} />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="ga-developer-token">{t("Developer token")}</Label>
          <Input id="ga-developer-token" type="password" value={developerToken} onChange={(e) => setDeveloperToken(e.target.value)} placeholder={estado.temSegredo ? "••••••••••••" : ""} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="ga-client-id">{t("OAuth client id")}</Label>
            <Input id="ga-client-id" type="password" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={estado.temSegredo ? "••••••••••••" : ""} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="ga-client-secret">{t("OAuth client secret")}</Label>
            <Input id="ga-client-secret" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={estado.temSegredo ? "••••••••••••" : ""} />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="ga-refresh-token">{t("Refresh token")}</Label>
          <Input id="ga-refresh-token" type="password" value={refreshToken} onChange={(e) => setRefreshToken(e.target.value)} placeholder={estado.temSegredo ? "••••••••••••" : ""} />
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="ga-aw-id">{t("AW conversion ID (client-side, opcional)")}</Label>
            <Input id="ga-aw-id" value={awConversionId} onChange={(e) => setAwConversionId(e.target.value)} placeholder="AW-123456789" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="ga-aw-label">{t("Label do contato")}</Label>
            <Input id="ga-aw-label" value={awContactLabel} onChange={(e) => setAwContactLabel(e.target.value)} />
          </div>
        </div>

        <span className="mt-2 text-xs font-medium text-muted-foreground">
          {t("Conversion Action ID por evento (server-side)")}
        </span>
        <div className="flex flex-col gap-2">
          <Input value={actionLead} onChange={(e) => setActionLead(e.target.value)} placeholder={t("Lead — customers/123/conversionActions/456")} />
          <Input value={actionQualified} onChange={(e) => setActionQualified(e.target.value)} placeholder={t("Qualificado — customers/123/conversionActions/789")} />
          <Input value={actionPurchase} onChange={(e) => setActionPurchase(e.target.value)} placeholder={t("Compra — customers/123/conversionActions/012")} />
        </div>

        <div className="flex items-center gap-2">
          <Switch checked={habilitado} onCheckedChange={setHabilitado} id="ga-enabled" />
          <Label htmlFor="ga-enabled">{t("Enviar eventos")}</Label>
        </div>
        <Button type="submit" disabled={isPending || !podeSalvar}>
          {isPending ? t("Validando com o Google Ads…") : t("Salvar")}
        </Button>
      </form>
    </Card>
  );
}
