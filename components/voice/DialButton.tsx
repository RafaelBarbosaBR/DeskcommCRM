"use client";
import { useState } from "react";
import { toast } from "sonner";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { Phone } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

/**
 * "Ligar" — dispara uma chamada de voz outbound e some: quem mostra o
 * progresso e os controles é `ActiveCallPanel` (montado uma vez em
 * `app/app/layout.tsx`), assim que o Realtime confirmar a linha nova em
 * `voice_calls`. Este botão não guarda estado de chamada nenhum.
 */
export function DialButton({
  contactId,
  phone,
  className,
}: {
  contactId: string | null;
  phone: string;
  className?: string;
}) {
  const t = useT();
  const [discando, setDiscando] = useState(false);

  return (
    <Button
      variant="outline"
      size="sm"
      className={className}
      disabled={discando}
      onClick={() => {
        setDiscando(true);
        apiClient
          .post("/api/v1/voice/calls", { contact_id: contactId, phone })
          .catch((err) => {
            toast.error(err instanceof ApiError ? err.message : t("Não consegui discar agora."));
          })
          .finally(() => setDiscando(false));
      }}
    >
      <Phone size={16} weight="bold" aria-hidden />
      <span>{discando ? t("Discando…") : t("Ligar")}</span>
    </Button>
  );
}
