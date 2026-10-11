import { describe, it, expect } from "vitest";
import { DialogueEnhancer } from "@/lib/webcodecs/dialogueEnhance";

// « Améliorer les dialogues » (11/10/2026) : ce que le traitement doit tenir, mesuré sur des signaux
// synthétiques. Les canaux de sortie sont ceux d'entrée (demande de Louis : la spatialisation reste),
// rien ne sature, l'état est continu d'un bloc à l'autre, et la voix gagne sur le reste.

const SR = 48000;

function tone(freq: number, seconds: number, amp: number, phase = 0): Float32Array {
  const n = Math.round(seconds * SR);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR + phase);
  return a;
}

// Un bruit reproductible (pas de Math.random : le test doit dire la même chose à chaque fois).
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

const rms = (a: Float32Array, from = 0) => {
  let s = 0;
  for (let i = from; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / (a.length - from));
};
const db = (x: number) => 20 * Math.log10(x);
const add = (a: Float32Array, b: Float32Array) => a.map((v, i) => v + b[i]);
const sub = (a: Float32Array, b: Float32Array) => a.map((v, i) => v - b[i]);
const half = (a: Float32Array) => a.map((v) => v * 0.5);
// La dernière seconde : le compresseur et les filtres sont établis.
const tail = SR;

describe("DialogueEnhancer", () => {
  it("rend autant de canaux et d'échantillons qu'il en reçoit, sans écrire dans les plans reçus", () => {
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

  it("ne sature jamais : tout reste sous −1 dBFS, même un signal à pleine échelle", () => {
    for (const mode of ["on", "strong"] as const) {
      const planes = Array.from({ length: 6 }, (_, c) => noise(1, 1, c + 7));
      const out = new DialogueEnhancer(SR, 6, mode).process(planes);
      let peak = 0;
      for (const p of out) for (const v of p) peak = Math.max(peak, Math.abs(v));
      expect(peak).toBeLessThanOrEqual(Math.pow(10, -1 / 20) + 1e-6);
    }
  });

  it("stéréo : la voix au milieu gagne sur ce qui est sur les côtés", () => {
    // Voix : une fréquence de présence, identique à gauche et à droite. Ambiance : en opposition.
    const voice = tone(2500, 3, 0.1);
    const amb = noise(3, 0.1, 3);
    const L = add(voice, amb);
    const R = sub(voice, amb);
    const [l, r] = new DialogueEnhancer(SR, 2, "on").process([L, R]);
    const before = db(rms(voice, tail)) - db(rms(amb, tail));
    const after = db(rms(half(add(l, r)), tail)) - db(rms(half(sub(l, r)), tail));
    expect(after - before).toBeGreaterThan(6);
  });

  it("5.1 : le centre gagne sur les faces et les ambiances, et le 5.1 reste un 5.1", () => {
    const voice = tone(2500, 3, 0.1);
    const front = noise(3, 0.1, 5);
    const back = noise(3, 0.1, 9);
    const planes = [front, front.slice(), voice, noise(3, 0.1, 11), back, back.slice()];
    const out = new DialogueEnhancer(SR, 6, "on").process(planes);
    const before = db(rms(voice, tail)) - db(rms(front, tail));
    const after = db(rms(out[2], tail)) - db(rms(out[0], tail));
    expect(after - before).toBeGreaterThan(4);
    // Les ambiances ne sont pas repliées ailleurs : elles sont toujours là, à leur place.
    expect(rms(out[4], tail)).toBeGreaterThan(0.005);
    expect(rms(out[5], tail)).toBeGreaterThan(0.005);
  });

  it("« Encore plus fort » rapproche davantage le fort et le faible que « Améliorer »", () => {
    // Un passage calme puis une explosion : l'écart doit fondre davantage en mode fort.
    const quiet = tone(1000, 2, 0.02);
    const loud = tone(1000, 2, 0.6);
    const sig = new Float32Array(quiet.length + loud.length);
    sig.set(quiet);
    sig.set(loud, quiet.length);
    const spread = (mode: "on" | "strong") => {
      const [o] = new DialogueEnhancer(SR, 1, mode).process([sig]);
      const q = rms(o.subarray(SR, quiet.length));
      const l = rms(o.subarray(quiet.length + SR));
      return db(l) - db(q);
    };
    const original = db(0.6) - db(0.02);
    expect(spread("on")).toBeLessThan(original);
    expect(spread("strong")).toBeLessThan(spread("on"));
  });

  it("l'état est continu : deux blocs donnent exactement ce que donne un seul", () => {
    const planes = Array.from({ length: 6 }, (_, c) => noise(0.5, 0.4, c + 21));
    const whole = new DialogueEnhancer(SR, 6, "strong").process(planes);
    const split = new DialogueEnhancer(SR, 6, "strong");
    const cut = 9001;
    const a = split.process(planes.map((p) => p.subarray(0, cut)));
    const b = split.process(planes.map((p) => p.subarray(cut)));
    for (let c = 0; c < 6; c++) {
      const joined = new Float32Array(whole[c].length);
      joined.set(a[c]);
      joined.set(b[c], cut);
      expect(joined).toEqual(whole[c]);
    }
  });

  it("après reset, il repart comme neuf (un saut n'emporte rien du passage d'avant)", () => {
    const first = [noise(0.3, 0.8, 1), noise(0.3, 0.8, 2)];
    const second = [noise(0.3, 0.2, 3), noise(0.3, 0.2, 4)];
    const used = new DialogueEnhancer(SR, 2, "on");
    used.process(first);
    used.reset();
    const fresh = new DialogueEnhancer(SR, 2, "on");
    expect(used.process(second)).toEqual(fresh.process(second));
  });

  it("une disposition inconnue (5 canaux) garde l'équilibre entre ses canaux : un seul gain pour tous", () => {
    const planes = [0.1, 0.2, 0.05, 0.3, 0.15].map((a, c) => tone(440 + c * 50, 2, a));
    const out = new DialogueEnhancer(SR, 5, "on").process(planes);
    for (let c = 1; c < 5; c++) {
      const before = rms(planes[c], tail) / rms(planes[0], tail);
      const after = rms(out[c], tail) / rms(out[0], tail);
      expect(after).toBeCloseTo(before, 3);
    }
  });
});
