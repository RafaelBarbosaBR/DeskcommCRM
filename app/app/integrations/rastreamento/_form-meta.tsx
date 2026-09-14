"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { updateTrackingMeta } from "@/app/actions/settings/updateTrackingMeta";
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
  credencial_invalida: "A Meta recusou o pixel_id/token. Confira os dois e tente de novo.",
  cifra_indisponivel: "Esta instalação está sem a chave mestra de criptografia — quem instalou o sistema precisa configurá-la.",
  erro_ao_gravar: "Não consegui gravar agora. Tente de novo em instantes.",
};

export function FormularioDeMeta({ estado, idioma }: { estado: EstadoDoProvider; idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [pixelId, setPixelId] = useState((estado.config.pixel_id as string) ?? "");
  const [token, setToken] = useState("");
  const [habilitado, setHabilitado] = useState(estado.habilitado);

  const podeSalvar = pixelId.trim().length >= 5 && (estado.temSegredo || token.trim().length >= 20);

  function salvar(evento: React.FormEvent) {
    evento.preventDefault();
    startTransition(async () => {
      const resultado = await updateTrackingMeta({
        pixel_id: pixelId.trim(),
        access_token: token.trim() || undefined,
        enabled: habilitado,
      });
      if (resultado.ok) {
        setToken("");
        toast.success(t("Meta conectado — testado contra a Graph API."));
        router.refresh();
        return;
      }
      toast.error(t(ERRO_EM_PORTUGUES[resultado.error] ?? "Não consegui salvar agora."));
    });
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Meta</h3>
        {estado.conectado && (
          <span className={`rounded px-2 py-0.5 text-xs ${estado.habilitado ? "bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
            {estado.habilitado ? t("ativo") : t("pausado")}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t("Pixel client-side + Conversions API server-side, mesmo event_id nos dois lados.")}</p>
      <form onSubmit={salvar} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="meta-pixel-id">{t("Pixel ID")}</Label>
          <Input id="meta-pixel-id" value={pixelId} onChange={(e) => setPixelId(e.target.value)} placeholder="123456789012345" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="meta-token">{t("Access token (Conversions API)")}</Label>
          <Input
            id="meta-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={estado.temSegredo ? "••••••••••••" : ""}
          />
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={habilitado} onCheckedChange={setHabilitado} id="meta-enabled" />
          <Label htmlFor="meta-enabled">{t("Enviar eventos")}</Label>
        </div>
        <Button type="submit" disabled={isPending || !podeSalvar}>
          {isPending ? t("Validando com a Meta…") : t("Salvar")}
        </Button>
      </form>
    </Card>
  );
}
