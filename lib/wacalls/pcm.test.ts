import { describe, expect, it } from "vitest";
import { bytesParaPcm16, float32ParaPcm16, pcm16ParaBytes, pcm16ParaFloat32 } from "./pcm";

describe("lib/wacalls/pcm", () => {
  it("float32ParaPcm16 -> pcm16ParaFloat32 é aproximadamente identidade", () => {
    const original = new Float32Array([0, 0.5, -0.5, 1, -1, 0.1, -0.1]);
    const pcm = float32ParaPcm16(original);
    const volta = pcm16ParaFloat32(pcm);
    for (let i = 0; i < original.length; i++) {
      expect(volta[i]).toBeCloseTo(original[i]!, 3);
    }
  });

  it("float32ParaPcm16 faz clamp de valores fora de [-1, 1]", () => {
    const pcm = float32ParaPcm16(new Float32Array([2, -2]));
    expect(pcm[0]).toBe(0x7fff);
    expect(pcm[1]).toBe(-0x8000);
  });

  it("pcm16ParaBytes -> bytesParaPcm16 é identidade exata (round-trip sem perda)", () => {
    const original = new Int16Array([0, 32767, -32768, -1, 1, 12345, -12345]);
    const bytes = pcm16ParaBytes(original);
    const volta = bytesParaPcm16(bytes);
    expect(Array.from(volta)).toEqual(Array.from(original));
  });

  it("pcm16ParaBytes produz o dobro de bytes das amostras (16 bits = 2 bytes)", () => {
    const bytes = pcm16ParaBytes(new Int16Array(10));
    expect(bytes.length).toBe(20);
  });

  it("bytesParaPcm16 descarta o byte final órfão em vez de lançar", () => {
    const bytes = new Uint8Array([1, 2, 3]); // comprimento ímpar
    expect(() => bytesParaPcm16(bytes)).not.toThrow();
    expect(bytesParaPcm16(bytes).length).toBe(1);
  });

  it("little-endian confirmado: byte baixo primeiro", () => {
    const bytes = pcm16ParaBytes(new Int16Array([1])); // 0x0001
    expect(bytes[0]).toBe(1);
    expect(bytes[1]).toBe(0);
  });
});
