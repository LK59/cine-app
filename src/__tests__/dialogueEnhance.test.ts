import { describe, it, expect } from "vitest";
import { DialogueEnhancer } from "@/lib/webcodecs/dialogueEnhance";

// « Améliorer les dialogues » v2 (12/10/2026) : ce que le traitement doit tenir, mesuré sur des signaux
// synthétiques. Les canaux de sortie sont ceux d'entrée (la spatialisation reste), rien ne sature,
// l'état est continu d'un bloc à l'autre, la voix gagne sur le reste — et, depuis la v2, la voix ne
// dépend plus jamais du fond : une explosion ne la baisse pas, « Améliorer davantage » non plus.

const SR = 48000;
function tone(freq: number, seconds: number, amp: number, phase = 0): Float32Array {
  const n = Math.round(seconds * SR);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR + phase);
  return a;
}
function noise(seconds: number, amp: number, seed = 1): Float32Array {
  const n = Math.round(seconds * SR);
  const a = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    a[i] = amp * ((s / 0x7fffffff) * 2 - 1);
  }
  return a;
}
/** Une « voix » : des formants (500, 1500, 2500 Hz) hachés en syllabes à 4 Hz. */
function speech(seconds: number, amp: number): Float32Array {
  const n = Math.round(seconds * SR);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
    a[i] = amp * env * (0.5 * Math.sin(2 * Math.PI * 500 * t) + 0.35 * Math.sin(2 * Math.PI * 1500 * t) + 0.25 * Math.sin(2 * Math.PI * 2500 * t));
  }
  return a;
}
/** Un grondement : bruit passé dans un passe-bas grossier (moyenne glissante), comme une explosion. */
function rumble(seconds: number, amp: number, seed = 3): Float32Array {
  const w = noise(seconds, 1, seed);
  const a = new Float32Array(w.length);
  let y = 0;
  for (let i = 0; i < w.length; i++) {
    y += 0.02 * (w[i] - y);
    a[i] = y * amp * 8;
  }
  return a;
}
const rms = (a: Float32Array, from = 0) => {
  let s = 0;
  for (let i = from; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / (a.length - from));
};
const db = (x: number) => 20 * Math.log10(x);
const add = (a: Float32Array, b: Float32Array) => a.map((v, i) => v + b[i]);
const sub = (a: Float32Array, b: Float32Array) => a.map((v, i) => v - b[i]);
const half = (a: Float32Array) => a.map((v) => v * 0.5);
const silence = (seconds: number) => new Float32Array(Math.round(seconds * SR));
const tail = SR;

describe("DialogueEnhancer", () => {
  it("rend autant de canaux et d'échantillons, sans écrire dans les plans reçus", () => {
    for (const channels of [1, 2, 3, 5, 6, 8]) {
      const planes = Array.from({ length: channels }, (_, c) => noise(0.2, 0.3, c + 1));
      const copies = planes.map((p) => p.slice());
      const out = new DialogueEnhancer(SR, channels, "on").process(planes);
      expect(out).toHaveLength(channels);
      for (let c = 0; c < channels; c++) {
        expect(out[c]).toHaveLength(planes[c].length);
        expect(planes[c]).toEqual(copies[c]);
      }
    }
  });

  it("ne sature jamais : tout reste sous −1 dBFS, même à pleine échelle", () => {
    for (const channels of [1, 2, 6, 8])
      for (const mode of ["on", "strong"] as const) {
        const planes = Array.from({ length: channels }, (_, c) => noise(1, 1, c + 7));
        const out = new DialogueEnhancer(SR, channels, mode).process(planes);
        let peak = 0;
        for (const p of out) for (const v of p) peak = Math.max(peak, Math.abs(v));
        expect(peak <= Math.pow(10, -1 / 20) + 1e-6, `${channels} ${mode} ${peak}`).toBe(true);
      }
  });

  it("stéréo : la voix au milieu gagne sur ce qui est sur les côtés", () => {
    const voice = speech(3, 0.1);
    const amb = noise(3, 0.1, 3);
    const [l, r] = new DialogueEnhancer(SR, 2, "on").process([add(voice, amb), sub(voice, amb)]);
    const before = db(rms(voice, tail)) - db(rms(amb, tail));
    const after = db(rms(half(add(l, r)), tail)) - db(rms(half(sub(l, r)), tail));
    expect(after - before > 4, `${after - before}`).toBe(true);
  });

  it("5.1 : le centre gagne sur les faces et les ambiances, et le 5.1 reste un 5.1", () => {
    const voice = speech(3, 0.1);
    const front = noise(3, 0.1, 5);
    const back = noise(3, 0.1, 9);
    const out = new DialogueEnhancer(SR, 6, "on").process([front, front.slice(), voice, noise(3, 0.1, 11), back, back.slice()]);
    const gain = db(rms(out[2], tail)) - db(rms(out[0], tail)) - (db(rms(voice, tail)) - db(rms(front, tail)));
    expect(gain > 4, `${gain}`).toBe(true);
    expect(rms(out[4], tail) > 0.005 && rms(out[5], tail) > 0.005).toBe(true);
  });

  it("l'état est continu : deux blocs donnent exactement ce que donne un seul", () => {
    for (const channels of [1, 2, 6]) {
      const planes = Array.from({ length: channels }, (_, c) => noise(0.5, 0.4, c + 21));
      const whole = new DialogueEnhancer(SR, channels, "strong").process(planes);
      const split = new DialogueEnhancer(SR, channels, "strong");
      const cut = 9001;
      const a = split.process(planes.map((p) => p.subarray(0, cut)));
      const b = split.process(planes.map((p) => p.subarray(cut)));
      for (let c = 0; c < channels; c++) {
        const joined = new Float32Array(whole[c].length);
        joined.set(a[c]);
        joined.set(b[c], cut);
        expect(joined).toEqual(whole[c]);
      }
    }
  });

  it("après reset, il repart comme neuf", () => {
    const used = new DialogueEnhancer(SR, 6, "on");
    used.process(Array.from({ length: 6 }, (_, c) => noise(0.3, 0.8, c + 1)));
    used.reset();
    const second = Array.from({ length: 6 }, (_, c) => noise(0.3, 0.2, c + 9));
    expect(used.process(second)).toEqual(new DialogueEnhancer(SR, 6, "on").process(second));
  });

  it("une disposition inconnue (5 canaux) garde l'équilibre entre ses canaux", () => {
    const planes = [0.1, 0.2, 0.05, 0.3, 0.15].map((a, c) => tone(440 + c * 50, 2, a));
    const out = new DialogueEnhancer(SR, 5, "on").process(planes);
    for (let c = 1; c < 5; c++) {
      const before = rms(planes[c], tail) / rms(planes[0], tail);
      const after = rms(out[c], tail) / rms(out[0], tail);
      expect(Math.abs(after - before) < 1e-3).toBe(true);
    }
  });

  // Le défaut entendu par Louis (Interstellar, l'explosion du vaisseau) : la voix baissait avec le fond.
  it("une explosion sur les faces et le caisson ne baisse pas la voix (centre indépendant du fond)", () => {
    for (const mode of ["on", "strong"] as const) {
      const voice = speech(4, 0.08);
      const quiet = [noise(4, 0.01, 1), noise(4, 0.01, 2), voice, silence(4), noise(4, 0.01, 3), noise(4, 0.01, 4)];
      const boom = [rumble(4, 0.5, 1), rumble(4, 0.5, 2), voice, rumble(4, 0.6, 5), rumble(4, 0.4, 3), rumble(4, 0.4, 4)];
      const a = new DialogueEnhancer(SR, 6, mode).process(quiet)[2];
      const b = new DialogueEnhancer(SR, 6, mode).process(boom)[2];
      expect(Math.abs(db(rms(b, tail)) - db(rms(a, tail))) < 0.1, `${mode}: ${db(rms(b, tail)) - db(rms(a, tail))}`).toBe(true);
    }
  });

  it("« Améliorer davantage » ne baisse jamais la voix par rapport à « Améliorer »", () => {
    for (const amp of [0.01, 0.05, 0.15]) {
      const voice = speech(4, amp);
      const planes = () => [rumble(4, 0.4, 1), rumble(4, 0.4, 2), voice, rumble(4, 0.5, 5), noise(4, 0.05, 3), noise(4, 0.05, 4)];
      const on = new DialogueEnhancer(SR, 6, "on").process(planes())[2];
      const strong = new DialogueEnhancer(SR, 6, "strong").process(planes())[2];
      expect(rms(strong, tail) >= rms(on, tail) * 0.99, `${amp}: ${db(rms(strong, tail)) - db(rms(on, tail))}`).toBe(true);
    }
  });

  it("le fond baisse quand quelqu'un parle, et beaucoup moins quand personne ne parle", () => {
    for (const mode of ["on", "strong"] as const) {
      const bg = () => [noise(4, 0.05, 1), noise(4, 0.05, 2)];
      const withVoice = new DialogueEnhancer(SR, 6, mode).process([...bg(), speech(4, 0.05), silence(4), noise(4, 0.03, 3), noise(4, 0.03, 4)]);
      const without = new DialogueEnhancer(SR, 6, mode).process([...bg(), silence(4), silence(4), noise(4, 0.03, 3), noise(4, 0.03, 4)]);
      const ducked = db(rms(without[0], tail)) - db(rms(withVoice[0], tail));
      expect(ducked > 1.5, `${mode}: retrait pendant la parole ${ducked}`).toBe(true);
      // Sans voix, le fond n'est jamais remonté (la v1 le remontait avec son rattrapage).
      expect(rms(without[0], tail) <= rms(noise(4, 0.05, 1), tail) * 1.001).toBe(true);
    }
  });

  it("« Améliorer davantage » retire plus de fond que « Améliorer » pendant la parole", () => {
    const planes = () => [rumble(4, 0.3, 1), rumble(4, 0.3, 2), speech(4, 0.05), rumble(4, 0.4, 5), noise(4, 0.05, 3), noise(4, 0.05, 4)];
    const on = new DialogueEnhancer(SR, 6, "on").process(planes());
    const strong = new DialogueEnhancer(SR, 6, "strong").process(planes());
    const gap = db(rms(on[0], tail)) - db(rms(strong[0], tail));
    expect(gap > 3, `${gap}`).toBe(true);
  });
});
