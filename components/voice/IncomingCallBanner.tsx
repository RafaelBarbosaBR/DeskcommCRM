"use client";
import { useState } from "react";
import { toast } from "sonner";

import { useAuth } from "@/hooks/auth/AuthProvider";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { Button } from "@/components/ui/button";
import { PhoneIncoming, PhoneX } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { useVoiceCall } from "./VoiceCallContext";

/** A faixa de "chamada entrando" — flutua sobre qualquer rota de `/app/*` enquanto toca. */
export function IncomingCallBanner() {
  const t = useT();
  const { user } = useAuth();
  const { chamadaRelevante, descartarChamadaAtual } = useVoiceCall();
  const [processando, setProcessando] = useState(false);

  if (!chamadaRelevante || chamadaRelevante.status !== "ringing") return null;
  // Já assumida por outra pessoa — não é MINHA notificação.
  if (chamadaRelevante.ownerUserId !== null && chamadaRelevante.ownerUserId !== user.id) return null;

  const aceitar = async () => {
    setProcessando(true);
    try {
      await apiClient.post(`/api/v1/voice/calls/${encodeURIComponent(chamadaRelevante.id)}/accept`, {});
      // O Realtime traz o status 'connected' — não precisa navegar aqui, o
      // ActiveCallPanel assume assim que a linha do banco confirmar.
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Não consegui atender agora."));
      setProcessando(false);
    }
  };

  const recusar = async () => {
    setProcessando(true);
    try {
      await apiClient.post(`/api/v1/voice/calls/${encodeURIComponent(chamadaRelevante.id)}/reject`, {});
      descartarChamadaAtual();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Não consegui recusar agora."));
    } finally {
      setProcessando(false);
    }
  };

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-50 flex items-center justify-between gap-4 bg-accent px-4 py-3 text-accent-foreground shadow-lg sm:inset-x-auto sm:right-4 sm:top-4 sm:rounded-lg"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <PhoneIncoming size={18} weight="bold" aria-hidden className="animate-pulse" />
        {t("Chamada de voz de")} {phoneForDisplay(chamadaRelevante.peerPhone)}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={processando} onClick={() => void recusar()}>
          <PhoneX size={14} aria-hidden />
          {t("Recusar")}
        </Button>
        <Button size="sm" disabled={processando} onClick={() => void aceitar()}>
          <PhoneIncoming size={14} aria-hidden />
          {t("Atender")}
        </Button>
      </div>
    </div>
  );
}
