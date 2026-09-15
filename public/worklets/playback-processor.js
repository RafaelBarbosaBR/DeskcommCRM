// AudioWorkletProcessor que recebe PCM16 mono 16kHz little-endian (o que o
// servidor WaCalls manda pelo canal de dados — mesmo formato de
// `capture-processor.js`, na direção contrária) e produz Float32 na taxa
// NATIVA do AudioContext de saída (normalmente 48000 Hz), que é o que o
// `process()` do Web Audio API exige.
//
// Roda na audio rendering thread — recebe os chunks via `this.port.onmessage`
// (postados pela thread principal, que é quem lê o `RTCDataChannel` de
// verdade em `hooks/voice/useVoiceCallSession.ts`) e os enfileira num buffer
// circular; `process()` consome dali no ritmo que o alto-falante pede.

const TAXA_ORIGEM_HZ = 16000;

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._passo = TAXA_ORIGEM_HZ / sampleRate; // < 1 quando sampleRate > 16000 (upsample)
    this._posicaoFracionaria = 0;
    // Buffer circular de ~2s @16kHz — folga generosa contra jitter da rede
    // sem acumular atraso perceptível numa ligação de voz.
    this._buffer = new Float32Array(TAXA_ORIGEM_HZ * 2);
    this._escrita = 0;
    this._leitura = 0;
    this._disponivel = 0;

    this.port.onmessage = (evento) => {
      const pcm16 = new Int16Array(evento.data);
      for (let i = 0; i < pcm16.length; i++) {
        if (this._disponivel >= this._buffer.length) break; // buffer cheio — descarta o resto (áudio velho, não faz sentido acumular atraso)
        const s = pcm16[i];
        this._buffer[this._escrita] = s < 0 ? s / 0x8000 : s / 0x7fff;
        this._escrita = (this._escrita + 1) % this._buffer.length;
        this._disponivel++;
      }
    };
  }

  _lerAmostra(indiceFracionario) {
    const idx = Math.floor(indiceFracionario);
    const frac = indiceFracionario - idx;
    const a = this._buffer[(this._leitura + idx) % this._buffer.length] ?? 0;
    const b = this._buffer[(this._leitura + idx + 1) % this._buffer.length] ?? a;
    return a + (b - a) * frac;
  }

  process(_inputs, outputs) {
    const canal = outputs[0]?.[0];
    if (!canal) return true;

    for (let i = 0; i < canal.length; i++) {
      const amostrasOrigemNecessarias = Math.floor(this._posicaoFracionaria) + 2;
      if (this._disponivel < amostrasOrigemNecessarias) {
        canal[i] = 0; // sem áudio suficiente ainda — silêncio, não ruído
        continue;
      }
      canal[i] = this._lerAmostra(this._posicaoFracionaria);
      this._posicaoFracionaria += this._passo;
      const consumido = Math.floor(this._posicaoFracionaria);
      if (consumido > 0) {
        this._leitura = (this._leitura + consumido) % this._buffer.length;
        this._disponivel -= consumido;
        this._posicaoFracionaria -= consumido;
      }
    }
    return true;
  }
}

registerProcessor("playback-processor", PlaybackProcessor);
