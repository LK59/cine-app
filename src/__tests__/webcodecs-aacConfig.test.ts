import { describe, it, expect, vi, afterEach } from "vitest";
import { aacCopyable, aacKnownPceChannels, parseAacConfig } from "@/lib/webcodecs/aacConfig";
import type { MatroskaFile, MatroskaTrack } from "@/lib/webcodecs/matroska";

// La configuration AAC des deux pistes de « Elle s'appelle Ruby » (2012), relue du fichier
// (`ffprobe -show_data`) : AAC-LC, 48 kHz, `channelConfiguration` 0 et un PCE — avant L R puis C,
// un mono latéral, une paire arrière, pas de caisson. Chromium dit oui à `mp4a.40.2` et refuse le
// segment d'initialisation qui la porte (MediaSource `ended`), mesuré le 10/10/2026.
const RUBY = Uint8Array.from([
  0x11, 0x80, 0x04, 0xc8, 0x44, 0x00, 0x20, 0x00, 0xc4, 0x0d, 0x4c, 0x61, 0x76, 0x63, 0x36, 0x32, 0x2e, 0x32, 0x39, 0x2e, 0x31,
  0x30, 0x31, 0x56, 0xe5, 0x00,
]);
/** AAC-LC 48 kHz 5.1 standard (`channelConfiguration` 6). */
const STANDARD_51 = Uint8Array.from([0x11, 0xb0]);

/** Un PCE écrit à la main, pour vérifier la reconnaissance des dispositions connues. */
function ascWithPce(front: boolean[], side: boolean[], back: boolean[], lfe: number): Uint8Array {
  const bits: number[] = [];
  const put = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  put(2, 5); // AAC-LC
  put(3, 4); // 48 kHz
  put(0, 4); // channelConfiguration 0 : le PCE suit
  put(0, 3); // frameLength, dependsOnCoreCoder, extension
  put(0, 4); // tag
  put(1, 2); // object_type
  put(3, 4); // sampling_frequency_index
  put(front.length, 4);
  put(side.length, 4);
  put(back.length, 4);
  put(lfe, 2);
  put(0, 3); // assoc
  put(0, 4); // cc
  put(0, 3); // mixdowns absents
  for (const cpe of [...front, ...side, ...back]) {
    put(cpe ? 1 : 0, 1);
    put(0, 4);
  }
  for (let i = 0; i < lfe; i++) put(0, 4);
  while (bits.length % 8) bits.push(0);
  return Uint8Array.from({ length: bits.length / 8 }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((v, b) => (v << 1) | b, 0));
}

describe("configuration AAC — l'AAC à PCE de « Elle s'appelle Ruby »", () => {
  it("relit la disposition décrite par le PCE", () => {
    const config = parseAacConfig(RUBY);
    expect(config).toMatchObject({ objectType: 2, channelConfiguration: 0 });
    expect(config?.pce).toEqual({ front: [true, false], side: [false], back: [true], lfe: 0, channels: 6 });
  });

  it("ne se copie pas, quand un AAC standard se copie", () => {
    expect(aacCopyable(RUBY)).toBe(false);
    expect(aacCopyable(STANDARD_51)).toBe(true);
    // Sans configuration, rien ne permet de refuser : le comportement d'avant.
    expect(aacCopyable(null)).toBe(true);
  });

  it("reconnaît les dispositions connues, et elles seules", () => {
    expect(aacKnownPceChannels(RUBY)).toBeNull();
    expect(aacKnownPceChannels(ascWithPce([false, true], [], [true], 1))).toBe(6);
    expect(aacKnownPceChannels(ascWithPce([true], [], [], 0))).toBe(2);
    expect(aacKnownPceChannels(ascWithPce([false, true, true], [], [true], 1))).toBe(8);
    expect(aacKnownPceChannels(STANDARD_51)).toBeNull();
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

describe("livraison — l'AAC à PCE est ré-encodé, pas copié", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function navigateurQuiDitOui() {
    vi.resetModules();
    // Ce que Chromium répond, à tort pour ce fichier : oui à tout AAC.
    vi.stubGlobal("window", { ManagedMediaSource: { isTypeSupported: (t: string) => /mp4a|avc1/.test(t) } });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 11; AFTT) AppleWebKit/537.36 Silk/152.4.7 like Chrome/152.0.7977.140" });
    return import("@/lib/webcodecs/remuxer");
  }

  it("ré-encode la piste de Ruby que le navigateur dit lisible", async () => {
    const remuxer = await navigateurQuiDitOui();
    expect(remuxer.audioDelivery(piste(RUBY))).toBe("transcode");
    expect(remuxer.playableAudio(piste(RUBY))).toBe(true);
  });

  it("copie toujours un AAC standard", async () => {
    const remuxer = await navigateurQuiDitOui();
    expect(remuxer.audioDelivery(piste(STANDARD_51))).toBe("copy");
  });

  it("annonce au classement les trois canaux qu'elle livrera, pas les six de la source", async () => {
    const remuxer = await navigateurQuiDitOui();
    expect(remuxer.deliveredAudio(piste(RUBY))).toEqual({ copied: false, channels: 3 });
  });
});

describe("décodage — L R C gardés d'une disposition inconnue", () => {
  it("garde trois canaux pour Ruby, tous pour un AAC ordinaire ou un PCE connu", async () => {
    const { keptAacChannels } = await import("@/lib/webcodecs/softwareAudio");
    const file = (asc: Uint8Array) => ({ tracks: [piste(asc)] }) as unknown as MatroskaFile;
    expect(keptAacChannels(file(RUBY), 2, 6)).toBe(3);
    expect(keptAacChannels(file(STANDARD_51), 2, 6)).toBe(6);
    expect(keptAacChannels(file(ascWithPce([false, true], [], [true], 1)), 2, 6)).toBe(6);
    expect(keptAacChannels(undefined, 2, 6)).toBe(6);
  });
});
