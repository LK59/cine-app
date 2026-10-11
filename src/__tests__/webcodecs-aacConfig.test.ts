import { describe, it, expect, vi, afterEach } from "vitest";
import {
  aacPlan,
  decodedOrderMeasuredHere,
  parseAacConfig,
  pceShape,
  remapPlanes,
  rewriteToStandard,
  standardConfigOf,
  standardMatrix,
  type Speaker,
} from "@/lib/webcodecs/aacConfig";
import type { MatroskaFile, MatroskaTrack } from "@/lib/webcodecs/matroska";

// La configuration AAC des deux pistes de « Elle s'appelle Ruby » (2012), relue du fichier
// (`ffprobe -show_data`) : AAC-LC, 48 kHz, `channelConfiguration` 0 et un PCE — avant [paire, mono],
// côté [mono], arrière [paire], pas de caisson. Octet pour octet ce que l'encodeur de FFmpeg écrit
// pour un 5.1 passé par un PCE (`-aac_pce 1`), mesuré le 10/10/2026.
const RUBY = Uint8Array.from([
  0x11, 0x80, 0x04, 0xc8, 0x44, 0x00, 0x20, 0x00, 0xc4, 0x0d, 0x4c, 0x61, 0x76, 0x63, 0x36, 0x32, 0x2e, 0x32, 0x39, 0x2e, 0x31,
  0x30, 0x31, 0x56, 0xe5, 0x00,
]);
/** AAC-LC 48 kHz 5.1 standard (`channelConfiguration` 6). */
const STANDARD_51 = Uint8Array.from([0x11, 0xb0]);
/** Le 5.1 standard de FFmpeg à 44,1 kHz, avec son extension de synchronisation 0x2b7 (`56 e5 00`). */
const STANDARD_51_SYNC = Uint8Array.from([0x12, 0x30, 0x56, 0xe5, 0x00]);

/**
 * Un PCE écrit à la main. Étiquettes canoniques par défaut — numérotées à partir de zéro par
 * nature, comme les écrit un encodeur en configuration implicite —, `tags` pour les forcer.
 */
function ascWithPce(
  front: boolean[],
  side: boolean[],
  back: boolean[],
  lfe: number,
  options: { frequencyIndex?: number; tags?: number[]; tail?: number[]; comment?: number[] } = {}
): Uint8Array {
  const bits: number[] = [];
  const put = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  const frequencyIndex = options.frequencyIndex ?? 3;
  put(2, 5); // AAC-LC
  put(frequencyIndex, 4);
  put(0, 4); // channelConfiguration 0 : le PCE suit
  put(0, 3); // frameLength, dependsOnCoreCoder, extension
  put(0, 4); // tag du PCE
  put(1, 2); // object_type
  put(frequencyIndex, 4);
  put(front.length, 4);
  put(side.length, 4);
  put(back.length, 4);
  put(lfe, 2);
  put(0, 3); // assoc
  put(0, 4); // cc
  put(0, 3); // mixdowns absents
  const next: Record<string, number> = { SCE: 0, CPE: 0, LFE: 0 };
  let i = 0;
  for (const cpe of [...front, ...side, ...back]) {
    put(cpe ? 1 : 0, 1);
    const kind = cpe ? "CPE" : "SCE";
    put(options.tags?.[i] ?? next[kind]++, 4);
    i++;
  }
  for (let l = 0; l < lfe; l++) put(options.tags?.[i++] ?? next.LFE++, 4);
  while (bits.length % 8) bits.push(0); // byte_alignment
  const comment = options.comment ?? [];
  put(comment.length, 8);
  for (const c of comment) put(c, 8);
  for (const byte of options.tail ?? []) put(byte, 8);
  return Uint8Array.from({ length: bits.length / 8 }, (_, j) => bits.slice(j * 8, j * 8 + 8).reduce((v, b) => (v << 1) | b, 0));
}

describe("couche 1 — le PCE relu élément par élément", () => {
  it("relit la disposition de Ruby, dans l'ordre du flux", () => {
    const config = parseAacConfig(RUBY);
    expect(config).toMatchObject({ objectType: 2, frequencyIndex: 3, channelConfiguration: 0 });
    expect(config?.pce).toMatchObject({ front: [true, false], side: [false], back: [true], lfe: 0, channels: 6 });
    expect(config?.pce?.elements).toEqual([
      { group: "front", kind: "CPE", tag: 0 },
      { group: "front", kind: "SCE", tag: 0 },
      { group: "side", kind: "SCE", tag: 1 },
      { group: "back", kind: "CPE", tag: 1 },
    ]);
    expect(pceShape(config!.pce!)).toBe("PM/M/P/0");
  });

  it("laisse une configuration standard sans PCE, et ne lève jamais sur des octets illisibles", () => {
    expect(parseAacConfig(STANDARD_51)).toMatchObject({ channelConfiguration: 6, pce: null });
    expect(parseAacConfig(Uint8Array.from([0x11]))).toBeNull();
    expect(parseAacConfig(Uint8Array.from([0x11, 0x80, 0x04]))).toBeNull(); // PCE tronqué
    expect(parseAacConfig(null)).toBeNull();
  });
});

describe("couche 2 — un PCE équivalent à une configuration standard est réécrit, la piste copiée", () => {
  it("reconnaît chaque configuration standard dans l'ordre de ses éléments", () => {
    const of = (asc: Uint8Array) => standardConfigOf(parseAacConfig(asc)!.pce!);
    expect(of(ascWithPce([false], [], [], 0))).toBe(1);
    expect(of(ascWithPce([true], [], [], 0))).toBe(2);
    expect(of(ascWithPce([false, true], [], [], 0))).toBe(3);
    expect(of(ascWithPce([false, true], [], [false], 0))).toBe(4);
    expect(of(ascWithPce([false, true], [], [true], 0))).toBe(5);
    expect(of(ascWithPce([false, true], [true], [], 1))).toBe(6); // ambiances en côté
    expect(of(ascWithPce([false, true], [], [true], 1))).toBe(6); // ou en arrière
    expect(of(ascWithPce([false, true, true], [], [true], 1))).toBe(7);
  });

  it("refuse un ordre différent — celui de Ruby, la paire avant devant le centre", () => {
    expect(standardConfigOf(parseAacConfig(RUBY)!.pce!)).toBeNull();
    expect(standardConfigOf(parseAacConfig(ascWithPce([true, false], [], [true], 1))!.pce!)).toBeNull();
  });

  it("refuse des étiquettes qu'un encodeur en configuration implicite n'écrirait pas", () => {
    // Deux paires à l'étiquette 0 : un décodeur strict ne saurait pas laquelle est l'ambiance.
    expect(standardConfigOf(parseAacConfig(ascWithPce([false, true], [], [true], 1, { tags: [0, 0, 0, 0] }))!.pce!)).toBeNull();
  });

  it("réécrit la configuration en recopiant bit pour bit ce qui suit le PCE", () => {
    // Le 5.1 de FFmpeg à 44,1 kHz, écrit en PCE équivalent avec son extension 0x2b7 : la réécriture
    // doit rendre exactement les octets que l'encodeur écrit en configuration implicite.
    const pce = ascWithPce([false, true], [], [true], 1, { frequencyIndex: 4, tail: [0x56, 0xe5, 0x00], comment: [0x4c, 0x61, 0x76] });
    expect(rewriteToStandard(pce)).toEqual(STANDARD_51_SYNC);
    expect(rewriteToStandard(ascWithPce([false, true], [true], [], 1))).toEqual(STANDARD_51);
  });

  it("ne réécrit ni Ruby, ni une configuration déjà standard", () => {
    expect(rewriteToStandard(RUBY)).toBeNull();
    expect(rewriteToStandard(STANDARD_51)).toBeNull();
  });
});

describe("couche 3 — décodé, rangé dans une disposition standard", () => {
  it("Ruby : forme mesurée, livrée en 5.1 entier dans l'ordre du décodeur", () => {
    expect(aacPlan(RUBY)).toEqual({ action: "decode", channels: 6, rows: null, keep: null, measured: true });
  });

  it("un décodeur jamais mesuré (AudioToolbox, sur Safari) : L R C, même pour Ruby", () => {
    expect(aacPlan(RUBY, { orderMeasured: false })).toEqual({ action: "decode", channels: 3, rows: null, keep: 3, measured: false });
  });

  it("ordre mesuré partout : hors Chromium, le décodeur AAC de FFmpeg en WebAssembly remplace AudioToolbox (11/10/2026)", () => {
    const at = (ua: string) => {
      vi.stubGlobal("navigator", { userAgent: ua });
      const answer = decodedOrderMeasuredHere();
      vi.unstubAllGlobals();
      return answer;
    };
    expect(at("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1")).toBe(true);
    expect(at("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15")).toBe(true);
    expect(at("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0 Safari/537.36")).toBe(true);
    expect(at("Mozilla/5.0 (Linux; Android 11; AFTT) AppleWebKit/537.36 (KHTML, like Gecko) Silk/152.4.7 like Chrome/152.0 Safari/537.36")).toBe(true);
  });

  it("une forme jamais mesurée : L R C, rien de deviné", () => {
    // Avant [paire, mono], côté [paire], sans caisson : l'ordre de sortie n'a jamais été mesuré.
    expect(aacPlan(ascWithPce([true, false], [true], [], 0))).toEqual({ action: "decode", channels: 3, rows: null, keep: 3, measured: false });
  });

  it("6.0 — le centre arrière va dans les deux ambiances à −3 dB, sans rien perdre", () => {
    const m = standardMatrix(["L", "R", "C", "Cs", "Lrs", "Rrs"]);
    expect(m.channels).toBe(6);
    const h = Math.SQRT1_2;
    // Lignes : L R C LFE Ls Rs ; colonnes : L R C Cs Lrs Rrs.
    expect(m.rows).toEqual([
      [1, 0, 0, 0, 0, 0],
      [0, 1, 0, 0, 0, 0],
      [0, 0, 1, 0, 0, 0],
      [0, 0, 0, 0, 0, 0], // pas de caisson à inventer
      [0, 0, 0, h, 1, 0],
      [0, 0, 0, h, 0, 1],
    ]);
  });

  it("7.1 côté + arrière replié en 5.1 : chaque ambiance à −3 dB, comme le repli du transcodeur", () => {
    const h = Math.SQRT1_2;
    const m = standardMatrix(["L", "R", "C", "LFE", "Ls", "Rs", "Lrs", "Rrs", "Cs"]);
    expect(m.rows[4]).toEqual([0, 0, 0, 0, h, 0, h, 0, h]);
    expect(m.rows[5]).toEqual([0, 0, 0, 0, 0, h, 0, h, h]);
  });

  it("un ordre déjà standard ressort tel quel", () => {
    expect(standardMatrix(["L", "R", "C", "LFE", "Ls", "Rs"] as Speaker[]).identity).toBe(true);
    expect(standardMatrix(["L", "R"] as Speaker[]).identity).toBe(true);
  });

  it("applique la matrice plan par plan", () => {
    const planes = [Float32Array.of(1), Float32Array.of(2), Float32Array.of(3), Float32Array.of(4)];
    const out = remapPlanes(planes, [
      [1, 0, 0, 0.5],
      [0, 1, 0, 0.5],
    ]);
    expect([...out[0]]).toEqual([3]);
    expect([...out[1]]).toEqual([4]);
  });
});

describe("couche 4 — un navigateur qui prend le PCE le reçoit copié", () => {
  it("copie Ruby tel quel quand le navigateur l'a prouvé, décode sinon", () => {
    expect(aacPlan(RUBY, { pceAccepted: true })).toEqual({ action: "copy" });
    expect(aacPlan(RUBY, { pceAccepted: false }).action).toBe("decode");
    expect(aacPlan(RUBY, { pceAccepted: null }).action).toBe("decode");
  });

  it("un PCE accepté part tel quel — comme avant le 10/10 —, réécrit seulement là où il est refusé ; un AAC standard toujours copié", () => {
    expect(aacPlan(ascWithPce([false, true], [], [true], 1), { pceAccepted: true }).action).toBe("copy");
    expect(aacPlan(ascWithPce([false, true], [], [true], 1), { pceAccepted: null }).action).toBe("rewrite");
    expect(aacPlan(ascWithPce([false, true], [], [true], 1), { pceAccepted: false }).action).toBe("rewrite");
    expect(aacPlan(STANDARD_51)).toEqual({ action: "copy" });
    expect(aacPlan(null)).toEqual({ action: "copy" });
  });
});

const piste = (codecPrivate: Uint8Array): MatroskaTrack =>
  ({
    number: 2,
    type: "audio",
    codecId: "A_AAC",
    codecPrivate,
    language: "fre",
    name: null,
    isDefault: true,
    isForced: false,
    audio: { channels: 6, sampleRate: 48000 },
  }) as unknown as MatroskaTrack;

describe("livraison — ce que le remultiplexeur fait de chaque piste", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function navigateur(stored: boolean | null) {
    vi.resetModules();
    const ua = "Mozilla/5.0 (Linux; Android 11; AFTT) AppleWebKit/537.36 Silk/152.4.7 like Chrome/152.0.7977.140";
    const store = new Map<string, string>();
    if (stored !== null) store.set("cine-aac-pce-mse:v2", JSON.stringify({ ua, ok: stored }));
    // Ce que Chromium répond, à tort pour ce fichier : oui à tout AAC.
    vi.stubGlobal("window", { ManagedMediaSource: { isTypeSupported: (t: string) => /mp4a|avc1/.test(t) } });
    vi.stubGlobal("navigator", { userAgent: ua });
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    return import("@/lib/webcodecs/remuxer");
  }

  it("ré-encode Ruby là où le PCE est refusé, en annonçant ses six canaux", async () => {
    const remuxer = await navigateur(false);
    expect(remuxer.audioDelivery(piste(RUBY))).toBe("transcode");
    expect(remuxer.deliveredAudio(piste(RUBY))).toEqual({ copied: false, channels: 6 });
  });

  it("copie Ruby là où le navigateur a prouvé prendre le PCE", async () => {
    const remuxer = await navigateur(true);
    expect(remuxer.audioDelivery(piste(RUBY))).toBe("copy");
    expect(remuxer.deliveredAudio(piste(RUBY))).toEqual({ copied: true, channels: 6 });
  });

  it("sans réponse connue : le chemin sûr (décodé), et la question posée en tâche de fond", async () => {
    const remuxer = await navigateur(null);
    expect(remuxer.audioDelivery(piste(RUBY))).toBe("transcode");
  });

  it("copie un PCE équivalent à un 5.1, sa configuration réécrite dans la description", async () => {
    const remuxer = await navigateur(false);
    const equivalent = ascWithPce([false, true], [], [true], 1);
    expect(remuxer.audioDelivery(piste(equivalent))).toBe("copy");
    expect(remuxer.trackAacPlan(piste(equivalent))).toMatchObject({ action: "rewrite", asc: STANDARD_51 });
  });

  it("copie toujours un AAC standard", async () => {
    const remuxer = await navigateur(null);
    expect(remuxer.audioDelivery(piste(STANDARD_51))).toBe("copy");
  });
});

describe("décodage — ce que le décodeur logiciel garde", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("garde les six canaux de Ruby, rien à changer pour un AAC ordinaire", async () => {
    vi.resetModules();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    // Un moteur Chromium, où le PCE se décode faute de réponse gardée (DECISIONS.md §62) ; ailleurs
    // il se copie tel quel et le décodeur n'a rien à ranger.
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36" });
    const { aacShaping } = await import("@/lib/webcodecs/softwareAudio");
    const file = (asc: Uint8Array) => ({ tracks: [piste(asc)] }) as unknown as MatroskaFile;
    expect(aacShaping(file(RUBY), 2, 6)).toEqual({ channels: 6, rows: null });
    expect(aacShaping(file(STANDARD_51), 2, 6)).toBeNull();
    expect(aacShaping(file(ascWithPce([true, false], [true], [], 0)), 2, 5)).toEqual({ channels: 3, rows: null });
    expect(aacShaping(undefined, 2, 6)).toBeNull();
  });
});
