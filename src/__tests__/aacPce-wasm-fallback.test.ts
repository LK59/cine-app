import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync } from "fs";
import { MemoryByteSource } from "@/lib/webcodecs/byteSource";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { aacPlan, parseAacConfig, pceShape } from "@/lib/webcodecs/aacConfig";
import { PROBE_ASC, notePceDecision, pceDecisionFacts, takePceCopyRefusal, __testing } from "@/lib/webcodecs/aacPceProbe";
import { trackAacPlan } from "@/lib/webcodecs/remuxer";
import { SoftwareAudioTrack, aacShaping, takeAacDecodeRoute, type DecodedAudio } from "@/lib/webcodecs/softwareAudio";
import type { MatroskaFile, MatroskaTrack } from "@/lib/webcodecs/matroska";

// Le repli d'un AAC à PCE par le décodeur AAC de FFmpeg en WebAssembly (DECISIONS.md §62), de bout
// en bout, sur un vrai flux AAC décodé ici même — pas un module simulé. aacWasm-route.test.ts
// prouve la route hors Chromium avec le module remplacé ; il manquait :
// - Chromium : l'AudioDecoder du navigateur d'abord, le WebAssembly seulement s'il refuse la piste
//   (« Elle s'appelle Ruby » sur une Fire TV, 10/10/2026), et jamais une copie tentée sans réponse ;
// - WebKit : la copie d'abord, puis — refusée et retenue pour cette forme — le décodage par le
//   WebAssembly, canaux au bon rang ;
// - un AAC ordinaire, copié tel quel partout, comme il l'a toujours été.
//
// Les flux viennent de fixtures/aac/generate.sh : six sinus, un par canal (L 440, R 660, C 880,
// LFE 55, Ls 1320, Rs 1760 Hz), encodés par l'encodeur AAC de FFmpeg forcé au PCE. Retrouver
// chaque sinus à son rang après décodage, c'est ce qui prouve l'ordre des canaux — l'erreur qui a
// déjà mis deux fois le dialogue dans une seule oreille ici (CLAUDE.md, « Channel order »).

const SAFARI_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1";
const SILK = "Mozilla/5.0 (Linux; Android 11; AFTT) AppleWebKit/537.36 (KHTML, like Gecko) Silk/152.4.7 like Chrome/152.0.7977.140 Safari/537.36";
const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

const DIR = "src/__tests__/fixtures/aac";
/** L R C LFE Ls Rs : le sinus que chaque rang doit porter, dans l'ordre standard. */
const TONES = [440, 660, 880, 55, 1320, 1760];

// L'AudioDecoder du navigateur passe par mediabunny ; Node n'en a pas. Le module est remplacé par
// un double dont on règle la réponse : la piste acceptée (Chromium décode lui-même) ou refusée.
const browser = vi.hoisted(() => ({ accepts: true, opened: 0 }));
vi.mock("mediabunny", () => {
  class Format {}
  class Input {
    constructor() {
      browser.opened++;
    }
    async getAudioTracks() {
      return [{ id: 1, codec: "aac", numberOfChannels: 6, sampleRate: 48000, canDecode: async () => browser.accepts }];
    }
  }
  class CustomSource {}
  class AudioSampleSink {
    async *samples() {
      yield {
        numberOfChannels: 6,
        numberOfFrames: 1,
        sampleRate: 48000,
        timestamp: 0,
        copyTo: (destination: Float32Array, options: { planeIndex: number }) => destination.set([options.planeIndex]),
        close: () => {},
      };
    }
  }
  return { Input, CustomSource, AudioSampleSink, MatroskaInputFormat: Format, Mp4InputFormat: Format };
});

// Le stockage du navigateur, où le refus d'une forme est retenu : Node n'en a pas par défaut.
const stored = new Map<string, string>();
const storage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, String(value)),
  removeItem: (key: string) => void stored.delete(key),
  clear: () => stored.clear(),
};

function ua(agent: string) {
  vi.stubGlobal("navigator", { userAgent: agent });
}

async function fixture(name: string): Promise<{ source: MemoryByteSource; file: MatroskaFile; track: MatroskaTrack }> {
  const source = new MemoryByteSource(new Uint8Array(readFileSync(`${DIR}/${name}`)));
  const file = (await openMediaFile(source)) as MatroskaFile;
  const track = file.tracks.find((t) => t.codecId === "A_AAC")!;
  return { source, file, track };
}

/** Le décodé entier, canal par canal. */
async function decodeAll(audio: SoftwareAudioTrack): Promise<Float32Array[]> {
  const chunks: DecodedAudio[] = [];
  for await (const chunk of audio.samples(0)) chunks.push(chunk);
  return Array.from({ length: audio.format.numberOfChannels }, (_, c) => {
    const plane = new Float32Array(chunks.reduce((n, chunk) => n + chunk.planes[c]!.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      plane.set(chunk.planes[c]!, at);
      at += chunk.planes[c]!.length;
    }
    return plane;
  });
}

/** La puissance d'un sinus dans un canal (Goertzel) — assez pour dire lequel des six y domine. */
function power(plane: Float32Array, frequency: number, sampleRate = 48000): number {
  const k = (2 * Math.cos((2 * Math.PI * frequency) / sampleRate));
  let s1 = 0;
  let s2 = 0;
  for (const x of plane) {
    const s = x + k * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return s1 * s1 + s2 * s2 - k * s1 * s2;
}

/** Pour chaque canal livré, le sinus qui y domine. */
function dominantTones(planes: Float32Array[]): number[] {
  return planes.map((plane) => TONES.reduce((best, f) => (power(plane, f) > power(plane, best) ? f : best), TONES[0]!));
}

beforeEach(() => {
  vi.stubGlobal("localStorage", storage);
  browser.accepts = true;
  browser.opened = 0;
  takeAacDecodeRoute();
});

afterEach(() => {
  vi.unstubAllGlobals();
  stored.clear();
  __testing.reset();
});

describe("les fixtures sont bien les formes en jeu", () => {
  it("FFmpeg 8.0 : le PCE de Ruby (« PM/M/P/0 ») ; FFmpeg 8.1 : un PCE équivalent au 5.1 standard", async () => {
    const ruby = await fixture("pce-51-lavc62.mkv");
    const config = parseAacConfig(ruby.track.codecPrivate)!;
    expect(config.channelConfiguration).toBe(0);
    expect(pceShape(config.pce!)).toBe("PM/M/P/0");
    // Les dix premiers octets — tout ce qui précède le commentaire « Lavc… » — sont ceux de Ruby.
    expect(Array.from(ruby.track.codecPrivate!.subarray(0, 10))).toEqual(Array.from(PROBE_ASC.subarray(0, 10)));

    const lfe = await fixture("pce-51-lavc63.mkv");
    expect(pceShape(parseAacConfig(lfe.track.codecPrivate)!.pce!)).toBe("MP/-/P/1");
  });
});

describe("Chromium : l'AudioDecoder du navigateur, le WebAssembly s'il refuse", () => {
  it("sans réponse de la sonde, la piste à PCE est décodée — jamais copiée pour voir", async () => {
    for (const agent of [SILK, CHROME_WIN]) {
      ua(agent);
      const { track } = await fixture("pce-51-lavc62.mkv");
      const plan = trackAacPlan(track);
      expect(plan).toEqual({ action: "decode", channels: 6, rows: null, keep: null, measured: true });
      // Ce que le remultiplexeur note : rien n'est copié, donc aucun refus à attendre ni à retenir.
      notePceDecision(plan.action, plan.action === "copy", track.codecPrivate);
      expect(takePceCopyRefusal()).toBe(false);
      expect(pceDecisionFacts()).toEqual({ aacPcePlan: "decode", aacPceAnswer: "inconnue" });
      expect(stored.get(__testing.REFUSALS_KEY)).toBeUndefined();
      __testing.reset();
    }
  });

  it("l'AudioDecoder du navigateur accepte : il décode, le WebAssembly n'est pas chargé", async () => {
    ua(SILK);
    const { source, file, track } = await fixture("pce-51-lavc62.mkv");
    const audio = await SoftwareAudioTrack.open(source, track.number, track.codecId, file);
    expect(browser.opened).toBe(1);
    expect(takeAacDecodeRoute()).toBe("browser-decode");
    expect(audio.format).toEqual({ sampleRate: 48000, numberOfChannels: 6 });
    // Le décodé du navigateur passe tel quel : l'ordre de ce PCE y a été mesuré (L R C LFE Ls Rs).
    const first = (await audio.samples(0).next()).value!;
    expect(first.planes.map((p: Float32Array) => p[0])).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("l'AudioDecoder du navigateur refuse : le WebAssembly décode, chaque canal à son rang", async () => {
    ua(SILK);
    browser.accepts = false;
    const { source, file, track } = await fixture("pce-51-lavc62.mkv");
    const audio = await SoftwareAudioTrack.open(source, track.number, track.codecId, file);
    expect(browser.opened).toBe(1);
    expect(takeAacDecodeRoute()).toBe("wasm-decode");
    expect(audio.format).toEqual({ sampleRate: 48000, numberOfChannels: 6 });
    const planes = await decodeAll(audio);
    expect(planes[0]!.length).toBeGreaterThan(48000 * 0.4);
    expect(dominantTones(planes)).toEqual(TONES);
    audio.close();
  });

  it("les deux refusent : l'erreur du navigateur, pour que l'hôte passe au serveur", async () => {
    ua(SILK);
    browser.accepts = false;
    // Une piste sans configuration : le décodeur WebAssembly ne peut pas l'ouvrir non plus.
    const file = { tracks: [{ number: 1, type: "audio", codecId: "A_AAC" }] } as unknown as MatroskaFile;
    await expect(SoftwareAudioTrack.open(new MemoryByteSource(new Uint8Array(16)), 1, "A_AAC", file)).rejects.toThrow(
      /le décodeur logiciel refuse aac/
    );
    expect(takeAacDecodeRoute()).toBeNull();
  });

  it("un PCE équivalent au 5.1 standard est réécrit et copié — ni décodé, ni ré-encodé", async () => {
    ua(SILK);
    const { track } = await fixture("pce-51-lavc63.mkv");
    const plan = trackAacPlan(track);
    expect(plan.action).toBe("rewrite");
    if (plan.action !== "rewrite") return;
    expect(parseAacConfig(plan.asc)).toMatchObject({ channelConfiguration: 6, pce: null });
    expect(plan.channels).toBe(6);
  });
});

describe("WebKit : la copie d'abord, le WebAssembly après un refus retenu pour cette forme", () => {
  it("copie, refus à l'envoi, reconstruction décodée par le WebAssembly — 5.1 entier, au bon rang", async () => {
    ua(SAFARI_IOS);
    const { source, file, track } = await fixture("pce-51-lavc62.mkv");

    // Première ouverture : copiée telle quelle, comme avant le 10/10.
    const first = trackAacPlan(track);
    expect(first).toEqual({ action: "copy" });
    notePceDecision(first.action, true, track.codecPrivate);

    // Safari la refuse avant la première image : retenu pour CETTE forme, à ce build.
    expect(takePceCopyRefusal()).toBe(true);
    const kept = JSON.parse(stored.get(__testing.REFUSALS_KEY)!) as { shapes: string[] };
    expect(kept.shapes).toEqual([Buffer.from(track.codecPrivate!).toString("hex")]);

    // La reconstruction décode — l'ordre est celui du décodeur WebAssembly, mesuré.
    const second = trackAacPlan(track);
    expect(second).toEqual({ action: "decode", channels: 6, rows: null, keep: null, measured: true });
    notePceDecision(second.action, false, track.codecPrivate);
    expect(pceDecisionFacts()).toEqual({ aacPcePlan: "decode", aacPceAnswer: false, aacPceFallback: "copie refusée → décodage" });

    // Et ce décodage passe par le WebAssembly, jamais par l'AudioDecoder de Safari.
    const audio = await SoftwareAudioTrack.open(source, track.number, track.codecId, file);
    expect(browser.opened).toBe(0);
    expect(takeAacDecodeRoute()).toBe("wasm-decode");
    expect(audio.format).toEqual({ sampleRate: 48000, numberOfChannels: 6 });
    expect(dominantTones(await decodeAll(audio))).toEqual(TONES);
    audio.close();
  });

  it("le refus d'une forme ne fait pas décoder l'autre : le PCE de FFmpeg 8.1 reste copié tel quel", async () => {
    ua(SAFARI_IOS);
    const ruby = await fixture("pce-51-lavc62.mkv");
    notePceDecision("copy", true, ruby.track.codecPrivate);
    takePceCopyRefusal();
    const other = await fixture("pce-51-lavc63.mkv");
    expect(trackAacPlan(other.track)).toEqual({ action: "copy" });
  });
});

describe("un AAC ordinaire, sans PCE, est copié tel quel partout", () => {
  // AAC-LC à 48 kHz : stéréo (configuration 2), 5.1 (configuration 6), 7.1 (configuration 7).
  const ordinary = {
    "2.0": Uint8Array.from([0x11, 0x90]),
    "5.1": Uint8Array.from([0x11, 0xb0]),
    "7.1": Uint8Array.from([0x11, 0xb8]),
  };

  it.each([SAFARI_IOS, SILK, CHROME_WIN, FIREFOX])("%s", (agent) => {
    ua(agent);
    for (const [name, asc] of Object.entries(ordinary)) {
      const track = { number: 1, type: "audio", codecId: "A_AAC", codecPrivate: asc } as unknown as MatroskaTrack;
      expect(parseAacConfig(asc)?.pce, name).toBeNull();
      expect(trackAacPlan(track), name).toEqual({ action: "copy" });
      expect(aacPlan(asc, { pceAccepted: false }), name).toEqual({ action: "copy" });
      // Décodé ailleurs (un repli), rien n'est rangé : le décodé tel quel, comme avant.
      const file = { tracks: [track] } as unknown as MatroskaFile;
      expect(aacShaping(file, 1, 6), name).toBeNull();
      expect(aacShaping(file, 1, 6, true), name).toBeNull();
    }
    expect(stored.size).toBe(0);
  });
});
