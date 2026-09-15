/**
 * PCM16 mono ⇄ Float32 — o formato que o servidor WaCalls espera sobre o
 * WebRTC DataChannel (16kHz, mono, 16 bits com sinal, little-endian), contra
 * o Float32 que a Web Audio API entrega/consome nativamente.
 *
 * Função pura, sem dependência de DOM: importável tanto pelo hook do
 * navegador (`hooks/voice/useVoiceCallSession.ts`) quanto por um teste
 * headless. O AudioWorklet real (`public/worklets/*.js`) roda num escopo que
 * não importa módulo TS — ele leva a MESMA matemática inline (worklet não tem
 * bundler); esta cópia é a que fica sob teste e serve de referência ao
 * escrever a outra.
 */

/** Amostra Float32 em [-1, 1] → inteiro 16 bits com sinal, com clamp nas bordas. */
export function float32ParaPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Inteiro 16 bits com sinal → Float32 em [-1, 1]. */
export function pcm16ParaFloat32(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = input[i]!;
    out[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
  }
  return out;
}

/** PCM16 → bytes little-endian, o que de fato viaja no DataChannel. */
export function pcm16ParaBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(i * 2, samples[i]!, true);
  }
  return out;
}

/** Bytes little-endian → PCM16. Corta o byte final órfão (comprimento ímpar) sem lançar. */
export function bytesParaPcm16(bytes: Uint8Array): Int16Array {
  const pares = Math.floor(bytes.length / 2);
  const out = new Int16Array(pares);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < pares; i++) {
    out[i] = view.getInt16(i * 2, true);
  }
  return out;
}

/** Taxa de amostragem que o servidor WaCalls exige — constante única, não mágica espalhada. */
export const WACALLS_SAMPLE_RATE_HZ = 16_000;
