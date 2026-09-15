"use client";
import { useEffect } from "react";
import { toast } from "sonner";

import { useAuth } from "@/hooks/auth/AuthProvider";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { Button } from "@/components/ui/button";
import { Microphone, MicrophoneSlash, PhoneX } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { useVoiceCallSession } from "@/hooks/voice/useVoiceCallSession";
import { useVoiceCall } from "./VoiceCallContext";

/**
 * A ligação em andamento — só monta (e só então pede microfone) quando a
 * chamada é MINHA e já está `connected`. Enquanto está `ringing`, quem
 * mostra é `IncomingCallBanner`; a transição de um para o outro é o
 * Realtime confirmando `accept`.
 */
export function ActiveCallPanel() {
  const t = useT();
  const { user } = useAuth();
  const { chamadaRelevante, descartarChamadaAtual } = useVoiceCall();

  const minha = chamadaRelevante?.status === "connected" && chamadaRelevante.ownerUserId === user.id;
  const { estado, erro, mudo, alternarMudo, encerrar } = useVoiceCallSession(minha ? chamadaRelevante!.id : null);

  useEffect(() => {
    if (erro) toast.error(erro);
  }, [erro]);

  if (!minha || !chamadaRelevante) return null;

  const encerrarChamada = async () => {
    encerrar();
    try {
      await apiClient.delete(`/api/v1/voice/calls/${encodeURIComponent(chamadaRelevante.id)}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("Não consegui encerrar agora."));
    } finally {
      descartarChamadaAtual();
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-72 flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-lg">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{phoneForDisplay(chamadaRelevante.peerPhone)}</span>
        <span className="text-xs text-muted-foreground">
          {estado === "conectando" ? t("Conectando…") : estado === "ativa" ? t("Em chamada") : t("Encerrada")}
        </span>
      </div>
      <div className="flex items-center justify-center gap-3">
        <Button
          size="icon"
          variant={mudo ? "default" : "outline"}
          disabled={estado !== "ativa"}
          onClick={alternarMudo}
          aria-label={mudo ? t("Ativar microfone") : t("Silenciar microfone")}
        >
          {mudo ? <MicrophoneSlash size={16} aria-hidden /> : <Microphone size={16} aria-hidden />}
        </Button>
        <Button
          size="icon"
          variant="destructive"
          onClick={() => void encerrarChamada()}
          aria-label={t("Encerrar chamada")}
        >
          <PhoneX size={16} aria-hidden />
        </Button>
      </div>
    </div>
  );
}
