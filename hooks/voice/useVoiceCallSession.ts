"use client";
import { useEffect, useRef, useState } from "react";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { logger } from "@/lib/logger";

export type EstadoDaSessaoDeVoz = "conectando" | "ativa" | "encerrada" | "erro";

/**
 * O lado do NAVEGADOR da chamada — microfone + alto-falante sobre um único
 * `RTCDataChannel` chamado exatamente `"pcm"` (o servidor WaCalls só cria o
 * bridge quando encontra ESSE label — confirmado lendo `cmd/server/bridge.go`
 * do vendorizado: `if dc.Label() != pcmChannelLabel { return }`).
 *
 * ═══ O CONTRATO, VERIFICADO CONTRA A FONTE DO SERVIDOR ═══
 *
 * Uma troca ÚNICA de sinalização (não é trickle ICE): o navegador monta a
 * OFERTA inteira — com o `RTCDataChannel` já criado, para o SDP incluir o
 * `m=application` — espera o ICE gathering terminar (`iceGatheringState ===
 * "complete"`), manda o SDP completo para `POST /api/v1/voice/calls/{id}/
 * webrtc` (`{sdp_offer}`) e recebe de volta uma RESPOSTA já completa
 * (`{sdp_answer}` — o servidor também espera o próprio ICE terminar antes de
 * responder, `<-gatherComplete` em `NewBridge`). Não há segunda rodada.
 *
 * PCM16 mono 16kHz little-endian nos dois sentidos — ver
 * `public/worklets/capture-processor.js`/`playback-processor.js` para a
 * conversão Float32⇄Int16 e a reamostragem (o AudioContext do browser quase
 * sempre roda a 48kHz nativo).
 *
 * ⚠️ O QUE NÃO FOI POSSÍVEL VERIFICAR: o comportamento de ponta a ponta com
 * áudio de verdade (microfone real, alto-falante real, um `RTCPeerConnection`
 * de verdade negociando ICE contra o servidor Go rodando numa rede real).
 * O contrato de sinalização foi confirmado rodando a imagem do servidor
 * nesta máquina; a MÍDIA em si não — não há microfone/alto-falante neste
 * ambiente para provar.
 */
export function useVoiceCallSession(callId: string | null): {
  estado: EstadoDaSessaoDeVoz;
  erro: string | null;
  mudo: boolean;
  alternarMudo: () => void;
  encerrar: () => void;
} {
  const [estado, setEstado] = useState<EstadoDaSessaoDeVoz>("conectando");
  const [erro, setErro] = useState<string | null>(null);
  const [mudo, setMudo] = useState(false);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const captureNodeRef = useRef<AudioWorkletNode | null>(null);
  const playbackNodeRef = useRef<AudioWorkletNode | null>(null);
  const mudoRef = useRef(false);

  useEffect(() => {
    mudoRef.current = mudo;
  }, [mudo]);

  useEffect(() => {
    if (!callId) return;
    let cancelado = false;

    const encerrarLocal = () => {
      captureNodeRef.current?.port.close();
      captureNodeRef.current?.disconnect();
      playbackNodeRef.current?.disconnect();
      captureNodeRef.current = null;
      playbackNodeRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      dcRef.current?.close();
      dcRef.current = null;
      pcRef.current?.close();
      pcRef.current = null;
      if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
        void audioCtxRef.current.close();
      }
      audioCtxRef.current = null;
    };

    const conectar = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (cancelado) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;

        const audioCtx = new AudioContext();
        audioCtxRef.current = audioCtx;
        await audioCtx.audioWorklet.addModule("/worklets/capture-processor.js");
        await audioCtx.audioWorklet.addModule("/worklets/playback-processor.js");
        if (cancelado) return;

        const pc = new RTCPeerConnection();
        pcRef.current = pc;

        const dc = pc.createDataChannel("pcm", { ordered: false, maxRetransmits: 0 });
        dcRef.current = dc;

        const captureNode = new AudioWorkletNode(audioCtx, "capture-processor");
        captureNodeRef.current = captureNode;
        const fonte = audioCtx.createMediaStreamSource(stream);
        fonte.connect(captureNode);
        captureNode.port.onmessage = (evento: MessageEvent<ArrayBuffer>) => {
          // Muda LOCALMENTE — o servidor não tem conceito de "mudo", então o
          // silêncio precisa acontecer antes de sair do navegador.
          if (mudoRef.current) return;
          if (dc.readyState === "open") dc.send(evento.data);
        };

        const playbackNode = new AudioWorkletNode(audioCtx, "playback-processor");
        playbackNodeRef.current = playbackNode;
        playbackNode.connect(audioCtx.destination);
        dc.onmessage = (evento: MessageEvent<ArrayBuffer>) => {
          playbackNode.port.postMessage(evento.data, [evento.data]);
        };

        pc.onconnectionstatechange = () => {
          if (cancelado) return;
          if (pc.connectionState === "failed" || pc.connectionState === "closed") {
            setEstado("encerrada");
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        // Sem trickle: espera o ICE terminar antes de mandar — o servidor
        // faz o mesmo do lado dele (confirmado na fonte).
        await new Promise<void>((resolve) => {
          if (pc.iceGatheringState === "complete") {
            resolve();
            return;
          }
          const verificar = () => {
            if (pc.iceGatheringState === "complete") {
              pc.removeEventListener("icegatheringstatechange", verificar);
              resolve();
            }
          };
          pc.addEventListener("icegatheringstatechange", verificar);
        });
        if (cancelado) return;

        const sdpOferta = pc.localDescription?.sdp;
        if (!sdpOferta) throw new Error("Não consegui montar a oferta de voz.");

        const resposta = await apiClient.post<{ data: { sdp_answer: string } }>(
          `/api/v1/voice/calls/${encodeURIComponent(callId)}/webrtc`,
          { sdp_offer: sdpOferta },
        );
        if (cancelado) return;

        await pc.setRemoteDescription({ type: "answer", sdp: resposta.data.sdp_answer });
        if (cancelado) return;
        setEstado("ativa");
      } catch (err) {
        if (cancelado) return;
        logger.warn("[voice] falha ao montar a sessão de voz no navegador", {
          erro: err instanceof Error ? err.message : "unknown",
        });
        const mensagem =
          err instanceof ApiError
            ? err.message
            : err instanceof DOMException && err.name === "NotAllowedError"
              ? "Permissão de microfone negada."
              : "Não consegui conectar o áudio desta chamada.";
        setErro(mensagem);
        setEstado("erro");
        encerrarLocal();
      }
    };

    void conectar();

    return () => {
      cancelado = true;
      encerrarLocal();
    };
  }, [callId]);

  return {
    estado,
    erro,
    mudo,
    alternarMudo: () => setMudo((m) => !m),
    encerrar: () => setEstado("encerrada"),
  };
}
