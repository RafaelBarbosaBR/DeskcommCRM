"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { updateTrackingGa4 } from "@/app/actions/settings/updateTrackingGa4";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import type { EstadoDoProvider } from "@/lib/rastreamento/estado-da-conexao";

const ERRO_EM_PORTUGUES: Record<string, string> = {
  validation_failed: "Confira os campos: algum valor não está no formato esperado.",
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só um administrador da organização pode mudar esta conexão.",
  mfa_required: "Confirme o segundo fator para salvar esta mudança.",
  credencial_invalida: "O GA4 recusou o measurement_id/api_secret no endpoint de debug. Confira os dois.",
  cifra_indisponivel: "Esta instalação está sem a chave mestra de criptografia — quem instalou o sistema precisa configurá-la.",
  erro_ao_gravar: "Não consegui gravar agora. Tente de novo em instantes.",
};

export function FormularioDeGa4({ estado, idioma }: { estado: EstadoDoProvider; idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [measurementId, setMeasurementId] = useState((estado.config.measurement_id as string) ?? "");
  const [apiSecret, setApiSecret] = useState("");
  const [habilitado, setHabilitado] = useState(estado.habilitado);

  const podeSalvar = /^G-[A-Z0-9]+$/.test(measurementId.trim()) && (estado.temSegredo || apiSecret.trim().length >= 10);

  function salvar(evento: React.FormEvent) {
    evento.preventDefault();
    startTransition(async () => {
      const resultado = await updateTrackingGa4({
        measurement_id: measurementId.trim(),
        api_secret: apiSecret.trim() || undefined,
        enabled: habilitado,
      });
      if (resultado.ok) {
        setApiSecret("");
        toast.success(t("GA4 conectado — testado no endpoint de debug."));
        router.refresh();
        return;
      }
      toast.error(t(ERRO_EM_PORTUGUES[resultado.error] ?? "Não consegui salvar agora."));
    });
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">GA4</h3>
        {estado.conectado && (
          <span className={`rounded px-2 py-0.5 text-xs ${estado.habilitado ? "bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
            {estado.habilitado ? t("ativo") : t("pausado")}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("Page view/contato só client-side (gtag). Lead/qualificado/compra só via Measurement Protocol, server-side.")}
      </p>
      <form onSubmit={salvar} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="ga4-measurement-id">{t("Measurement ID")}</Label>
          <Input id="ga4-measurement-id" value={measurementId} onChange={(e) => setMeasurementId(e.target.value)} placeholder="G-XXXXXXXXXX" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="ga4-api-secret">{t("API secret (Measurement Protocol)")}</Label>
          <Input
            id="ga4-api-secret"
            type="password"
            value={apiSecret}
            onChange={(e) => setApiSecret(e.target.value)}
            placeholder={estado.temSegredo ? "••••••••••••" : ""}
          />
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={habilitado} onCheckedChange={setHabilitado} id="ga4-enabled" />
          <Label htmlFor="ga4-enabled">{t("Enviar eventos")}</Label>
        </div>
        <Button type="submit" disabled={isPending || !podeSalvar}>
          {isPending ? t("Validando com o GA4…") : t("Salvar")}
        </Button>
      </form>
    </Card>
  );
}
