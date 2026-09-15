"use client";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { toast } from "sonner";

import { ApiError } from "@/lib/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CircleNotch, Phone, QrCode, Trash } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { usePairVoiceSession, useUnpairVoiceSession, useVoiceSessionStatus } from "@/hooks/voice/useVoiceSession";

function errMsg(err: unknown, fallback: string, t: (texto: string) => string): string {
  return err instanceof ApiError && err.message ? t(err.message) : t(fallback);
}

/**
 * Pareamento da chamada de voz — a mesma ideia da aba "Números por QR", mas
 * um pareamento PRÓPRIO: independente do número de mensagens (ver o
 * cabeçalho da migration 0247). Uma organização pode ter o WhatsApp de
 * mensagens conectado e a chamada de voz desconectada, ou vice-versa.
 */
export function CanalVozClient() {
  const t = useT();
  const { sessao, isLoading } = useVoiceSessionStatus();
  const pair = usePairVoiceSession();
  const unpair = useUnpairVoiceSession();
  const [qrImg, setQrImg] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    const qr = sessao?.qr ?? null;
    if (!qr) {
      // Sem QR (desparado, ou já pareado): resolve no próprio microtask, não
      // direto no corpo do efeito — evita o encadeamento de render síncrono
      // que a regra `react-hooks/set-state-in-effect` está de olho.
      Promise.resolve().then(() => {
        if (!cancelado) setQrImg(null);
      });
      return () => {
        cancelado = true;
      };
    }
    QRCode.toDataURL(qr, { width: 240, margin: 1 })
      .then((url) => {
        if (!cancelado) setQrImg(url);
      })
      .catch(() => {
        if (!cancelado) setQrImg(null);
      });
    return () => {
      cancelado = true;
    };
  }, [sessao?.qr]);

  if (isLoading) {
    return (
      <Card className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <CircleNotch className="animate-spin" size={16} />
        {t("Carregando…")}
      </Card>
    );
  }

  const pareado = sessao?.status === "open";

  return (
    <Card className="space-y-4 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Phone size={16} weight="bold" aria-hidden />
            {t("Chamada de voz")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(
              "Pareamento próprio para chamada de voz pelo WhatsApp — separado da conexão de mensagens.",
            )}
          </p>
        </div>
        <Badge variant={pareado ? "success" : "neutral"}>
          {pareado ? t("Pareado") : t("Não pareado")}
        </Badge>
      </div>

      {pareado ? (
        <div className="space-y-3">
          {sessao?.jid ? (
            <p className="text-xs text-muted-foreground">{t("Número pareado")}: {sessao.jid.split("@")[0]}</p>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={unpair.isPending}
            onClick={() => {
              if (!confirm(t("Desparear a chamada de voz? Você vai precisar escanear o QR de novo para usar."))) return;
              unpair.mutate(undefined, {
                onError: (err) => toast.error(errMsg(err, "Não consegui desparear agora.", t)),
                onSuccess: () => toast.success(t("Desparado.")),
              });
            }}
          >
            <Trash size={14} aria-hidden />
            {unpair.isPending ? t("Desparando…") : t("Desparear")}
          </Button>
        </div>
      ) : sessao?.status === "qr" || sessao?.status === "connecting" ? (
        <div className="flex flex-col items-center gap-3">
          {qrImg ? (
            // eslint-disable-next-line @next/next/no-img-element -- data URL gerado no cliente, sem ganho de next/image
            <img
              src={qrImg}
              alt={t("QR code para parear a chamada de voz")}
              width={240}
              height={240}
              className="rounded-md border border-border bg-white p-2"
            />
          ) : (
            <div className="flex h-60 w-60 items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
              {t("Aguardando QR…")}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {t("Abra o WhatsApp do número que vai fazer chamadas → Aparelhos conectados → escaneie o código.")}
          </p>
        </div>
      ) : (
        <Button
          size="sm"
          disabled={pair.isPending}
          onClick={() => {
            pair.mutate(undefined, {
              onError: (err) => toast.error(errMsg(err, "Não consegui iniciar o pareamento agora.", t)),
            });
          }}
        >
          <QrCode size={14} aria-hidden />
          {pair.isPending ? t("Iniciando…") : t("Parear número")}
        </Button>
      )}
    </Card>
  );
}
