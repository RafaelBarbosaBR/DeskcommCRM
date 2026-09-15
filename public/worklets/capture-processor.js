// AudioWorkletProcessor que converte o microfone (Float32, na taxa nativa do
// AudioContext — normalmente 48000 Hz) para PCM16 mono 16kHz little-endian,
// o formato exato que o servidor WaCalls espera no canal de dados WebRTC
// (confirmado na fonte do servidor: `internal/voip/media`, PCM16LE 16kHz —
// ver o cabeçalho de `lib/wacalls/pcm.ts`, que tem a mesma matemática pura
// em TypeScript para quem quiser reler sem reimplementar aqui).
//
// Roda na AUDIO RENDERING THREAD — sem acesso a `fetch`, `RTCDataChannel`
// nem ao DOM. Só pode falar com a thread principal via `this.port`; quem
// pega essas mensagens e escreve no `RTCDataChannel` de verdade é
// `hooks/voice/useVoiceCallSession.ts`.
//
// Registrado como módulo via `audioWorklet.addModule("/worklets/capture-processor.js")`.

const TAXA_ALVO_HZ = 16000;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` é global do escopo do worklet — a taxa NATIVA do
    // AudioContext que instanciou este processor.
    this._passo = sampleRate / TAXA_ALVO_HZ;
    this._posicaoFracionaria = 0;
    // Acumula amostras de entrada entre chamadas de `process` (que recebe
    // blocos de 128 amostras) até ter o suficiente para produzir pelo menos
    // uma amostra reamostrada — evita descartar o resto de um bloco.
    this._resto = new Float32Array(0);
  }

  // Reamostragem linear simples — qualidade suficiente para voz (o próprio
  // codec do servidor, MLow, já é de banda estreita). `entrada` inclui o
  // `_resto` do bloco anterior colado na frente.
  _reamostrar(entrada) {
    const nAmostrasSaida = Math.floor((entrada.length - 1 - this._posicaoFracionaria) / this._passo) + 1;
    if (nAmostrasSaida <= 0) {
      this._resto = entrada;
      return new Float32Array(0);
    }
    const saida = new Float32Array(nAmostrasSaida);
    let pos = this._posicaoFracionaria;
    for (let i = 0; i < nAmostrasSaida; i++) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = entrada[idx] ?? 0;
      const b = entrada[idx + 1] ?? a;
      saida[i] = a + (b - a) * frac;
      pos += this._passo;
    }
    // O que sobrou depois da última amostra consumida vira o resto do
    // próximo bloco, preservando a posição fracionária entre chamadas.
    const consumido = Math.floor(pos);
    this._resto = entrada.slice(consumido);
    this._posicaoFracionaria = pos - consumido;
    return saida;
  }

  process(inputs) {
    const canal = inputs[0]?.[0];
    if (!canal || canal.length === 0) return true; // sem microfone ainda conectado — segue vivo

    const juntado = new Float32Array(this._resto.length + canal.length);
    juntado.set(this._resto, 0);
    juntado.set(canal, this._resto.length);

    const reamostrado = this._reamostrar(juntado);
    if (reamostrado.length === 0) return true;

    // Float32 [-1,1] -> Int16 LE, mesma matemática de
    // `lib/wacalls/pcm.ts:float32ParaPcm16`/`pcm16ParaBytes`.
    const bytes = new ArrayBuffer(reamostrado.length * 2);
    const view = new DataView(bytes);
    for (let i = 0; i < reamostrado.length; i++) {
      const s = Math.max(-1, Math.min(1, reamostrado[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    // Transferable: zero-copy para a thread principal.
    this.port.postMessage(bytes, [bytes]);
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
