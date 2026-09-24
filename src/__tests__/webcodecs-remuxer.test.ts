import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Remuxer, unifiedAudioCodec, audioDelivery, plannedMimeTypes, playableAudio, remuxableAudio,
  unifiedAudioChannels,
} from "@/lib/webcodecs/remuxer";
import type { MatroskaFile, MatroskaTrack, MediaSample } from "@/lib/webcodecs/matroska";
import type { ByteSource } from "@/lib/webcodecs/byteSource";

// A stand-in transcoder, so the one property that matters here can be checked: what is released,
// and when. The real one needs a decoder and an encoder that exist only in a browser.
const opened: { closed: boolean }[] = [];
let transcoderCodec = "mp4a.40.2";
let failNextFrames = false;
/** Ce que rend `framesUpTo`, et où on le lui a demandé — par défaut, rien. */
let framesHook: ((endSeconds: number) => Promise<{ data: Uint8Array; timestampUs: number; durationUs: number }[]>) | null = null;
vi.mock("@/lib/webcodecs/audioTranscode", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/webcodecs/audioTranscode")>();
  return {
    ...original,
    AudioTranscoder: {
      open: async () => {
        const instance = {
          closed: false,
          codecString: transcoderCodec,
          sampleEntry: new Uint8Array([0, 0, 0, 8, 0x6d, 0x70, 0x34, 0x61]),
          sampleRate: 48000,
          channels: 6,
          seekTo: () => {},
          framesUpTo: async (endSeconds: number) => {
            if (failNextFrames) {
              failNextFrames = false;
              throw new Error("InternalAudioEncoderCocoa encoding failed");
            }
            return framesHook ? framesHook(endSeconds) : [];
          },
          close() {
            this.closed = true;
          },
        };
        opened.push(instance);
        return instance;
      },
    },
  };
});

// Le lecteur d'échantillons, remplacé pour pouvoir donner au remultiplexeur de vraies images à
// lire. Vide par défaut — le comportement d'avant pour tous les tests qui ne s'en servent pas :
// le fichier est fini dès la première lecture.
let readerSamples: MediaSample[] = [];
/** Où le remultiplexeur a repointé le lecteur. */
const readerSeeks: number[] = [];
vi.mock("@/lib/webcodecs/sampleReader", () => ({
  SampleReader: class {
    private queue = [...readerSamples];
    async next() {
      return this.queue.shift() ?? null;
    }
    seekTo(offset: number) {
      readerSeeks.push(offset);
    }
  },
}));

/** Une image HEVC IDR, longueur sur quatre octets comme le dit HVCC ci-dessous. */
function idr(timestampUs: number): MediaSample {
  return { trackNumber: 1, timestampUs, durationUs: 40_000, isKey: true, data: new Uint8Array([0, 0, 0, 3, 0x26, 0x01, 0xaf]) };
}

const HVCC = new Uint8Array([1, 1, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0x78, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, 0]);
const AVCC = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 4, 0x68, 0xee, 0x3c, 0xb0]);
const AAC_CONFIG = new Uint8Array([0x11, 0x90]);

function track(o: Partial<MatroskaTrack> & Pick<MatroskaTrack, "number" | "type" | "codecId">): MatroskaTrack {
  return {
    codecPrivate: null, language: "fra", name: null,
    isDefault: true, isForced: false, isHearingImpaired: false, isEnabled: true, defaultDurationNs: null, ...o,
  };
}

const VIDEO = track({ number: 1, type: "video", codecId: "V_MPEGH/ISO/HEVC", codecPrivate: HVCC, video: { width: 1920, height: 1080 } });
const AUDIO_FR = track({ number: 2, type: "audio", codecId: "A_AAC", codecPrivate: AAC_CONFIG, audio: { sampleRate: 48000, channels: 2 } });
const AUDIO_EN = track({ ...AUDIO_FR, number: 3, language: "eng" });
const SRT_FR = track({ number: 4, type: "subtitle", codecId: "S_TEXT/UTF8" });
const ASS = track({ number: 5, type: "subtitle", codecId: "S_TEXT/ASS" });
const PGS = track({ number: 6, type: "subtitle", codecId: "S_HDMV/PGS" });

const FILE: MatroskaFile = {
  timestampScaleNs: 1_000_000, durationSeconds: 5400,
  tracks: [VIDEO, AUDIO_FR, AUDIO_EN, SRT_FR, ASS, PGS], cues: [],
  segmentDataStart: 0, segmentEnd: 1000, firstClusterOffset: 0,
};

const SOURCE: ByteSource = { size: 1000, read: async () => new Uint8Array(0), close: () => {} };

// What a track becomes is now asked of the browser, so these need one to ask. This stands in for
// a player that takes every codec in a container — the iPhone case, where nothing is re-encoded.
beforeEach(() => {
  vi.stubGlobal("window", { ManagedMediaSource: { isTypeSupported: () => true } });
});
afterEach(() => vi.unstubAllGlobals());

const open = (audio: MatroskaTrack | null = AUDIO_FR) =>
  Remuxer.open(SOURCE, FILE, VIDEO, audio, { width: 1920, height: 1080 });

describe("un saut", () => {
  it("met la source en route sur sa cible avant de lire quoi que ce soit", async () => {
    // The index says where the seek lands several milliseconds before the parser asks for its
    // first byte, and those used to be spent idle — followed by one lone request on an empty
    // link. On a dense file four megabytes have to arrive before the first picture exists.
    const warm = vi.fn();
    const read = vi.fn(async () => new Uint8Array(0));
    const source: ByteSource = { size: 1000, read, close: () => {}, warm };
    const remuxer = await Remuxer.open(source, FILE, VIDEO, AUDIO_FR, { width: 1920, height: 1080 });

    read.mockClear();
    remuxer.seekTo(120);

    expect(warm).toHaveBeenCalledTimes(1);
    expect(typeof warm.mock.calls[0][0]).toBe("number");
    // And nothing was read to get there: the offset came from the index.
    expect(read).not.toHaveBeenCalled();
    remuxer.close();
  });

  it("se passe très bien d'une source qui ne sait pas se préchauffer", async () => {
    // A source already holding the whole file has nothing to warm, and must not be asked to.
    const remuxer = await open();
    expect(() => remuxer.seekTo(120)).not.toThrow();
    remuxer.close();
  });
});

describe("Remuxer track selection", () => {
  it("offers only the subtitle tracks it can actually render as text", async () => {
    const remuxer = await open();
    const numbers = remuxer.subtitleTracks().map((t) => t.number);
    // Image subtitles carry no text to extract, so offering them would be a menu entry that
    // silently does nothing.
    expect(numbers).toContain(SRT_FR.number);
    expect(numbers).not.toContain(PGS.number);
  });

  it("offers the styled formats it can strip to text, alongside plain ones", async () => {
    const remuxer = await open();
    const numbers = remuxer.subtitleTracks().map((t) => t.number);
    // ASS carries positioning and fonts this cannot honour, but its dialogue lines are text and
    // showing them plainly beats showing nothing.
    expect(numbers).toContain(ASS.number);
  });

  it("lists every audio track, so the language menu is complete", async () => {
    const remuxer = await open();
    expect(remuxer.audioTracks().map((t) => t.language)).toEqual(["fra", "eng"]);
  });

  it("states the file's length and the codecs a browser will be asked about", async () => {
    const plan = (await open()).plan();
    expect(plan.durationSeconds).toBe(5400);
    expect(plan.videoMimeType).toMatch(/^video\/mp4; codecs="hvc1\./);
    expect(plan.audioMimeType).toBe('audio/mp4; codecs="mp4a.40.2"');
    expect(plan.videoInit.length).toBeGreaterThan(100);
  });

  it("reports no delay before anything has been read", async () => {
    expect((await open()).diagnostics()).toEqual({
      presentationDelaySeconds: 0,
      clampedSamples: 0,
      transcodedAudio: false,
      transcodedCodec: null,
      segmentStartSeconds: 0,
    });
  });

  it("refuses a codec it can neither repackage nor re-encode", async () => {
    // RealAudio has no decoder here at all, so there is nothing to turn it into.
    const cook = track({ number: 2, type: "audio", codecId: "A_REAL/COOK", audio: { sampleRate: 48000, channels: 6 } });
    await expect(Remuxer.open(SOURCE, FILE, VIDEO, cook, { width: 1920, height: 1080 })).rejects.toThrow(/A_REAL\/COOK/);

    const vp9 = track({ number: 1, type: "video", codecId: "V_VP9" });
    await expect(Remuxer.open(SOURCE, FILE, vp9, null, { width: 1920, height: 1080 })).rejects.toThrow(/V_VP9/);
  });

  it("carries TrueHD by re-encoding it, like DTS", () => {
    // 21/09/2026. Until then no decoder existed here and a TrueHD-only VO went to the server.
    const trueHd = track({ number: 2, type: "audio", codecId: "A_TRUEHD", audio: { sampleRate: 48000, channels: 8 } });
    expect(playableAudio(trueHd)).toBe(true);
    expect(remuxableAudio(trueHd)).toBe(false);
    expect(audioDelivery(trueHd)).toBe("transcode");
    expect(plannedMimeTypes(VIDEO, trueHd).audio).toBe('audio/mp4; codecs="mp4a.40.2"');
  });

  it("counts a track that has to be re-encoded as playable, and says what will arrive", () => {
    const dts = track({ number: 2, type: "audio", codecId: "A_DTS", audio: { sampleRate: 48000, channels: 6 } });
    // Even a player that takes everything else has no DTS, so what reaches it is what comes out
    // of the encoder — and that is what the MIME type has to describe.
    expect(playableAudio(dts)).toBe(true);
    expect(remuxableAudio(dts)).toBe(false);
    expect(plannedMimeTypes(VIDEO, dts).audio).toBe('audio/mp4; codecs="mp4a.40.2"');
  });

  it("carries a codec the player takes, and re-encodes the same codec where it does not", () => {
    const eac3 = track({ number: 2, type: "audio", codecId: "A_EAC3", audio: { sampleRate: 48000, channels: 6 } });
    expect(audioDelivery(eac3)).toBe("copy");
    expect(plannedMimeTypes(VIDEO, eac3).audio).toBe('audio/mp4; codecs="ec-3"');

    // The same track on a player with no Dolby decoder — Chrome, which would otherwise lose the
    // hardware path over most of a library.
    vi.stubGlobal("window", { ManagedMediaSource: { isTypeSupported: (t: string) => t.includes("mp4a") } });
    expect(audioDelivery(eac3)).toBe("transcode");
    expect(plannedMimeTypes(VIDEO, eac3).audio).toBe('audio/mp4; codecs="mp4a.40.2"');
  });

  it("carries FLAC untouched where the player takes it, and re-encodes it on Safari", () => {
    // *Stand by Me*, 21/09/2026: its FLAC track, chosen on an iPhone, sent the film to the server
    // player — "la piste A_FLAC ne peut pas être portée ici". Chrome and Firefox take FLAC in a
    // MediaSource and must go on doing so.
    const flac = track({ number: 3, type: "audio", codecId: "A_FLAC", audio: { sampleRate: 48000, channels: 2 } });
    expect(audioDelivery(flac)).toBe("copy");

    vi.stubGlobal("window", { ManagedMediaSource: { isTypeSupported: (t: string) => !t.includes("flac") } });
    expect(audioDelivery(flac)).toBe("transcode");
    expect(playableAudio(flac)).toBe(true);
    expect(plannedMimeTypes(VIDEO, flac).audio).toBe('audio/mp4; codecs="mp4a.40.2"');
  });

  it("delivers every track in one codec when they cannot all keep their own — per-file unification", () => {
    // Utopia: DTS beside AC-3, on a player that takes AC-3 natively. Left alone, choosing the
    // other language changes what the audio buffer decodes by mid-playback — which this device
    // answers with "media failed to decode", closing the MediaSource and taking the picture with
    // it. So both are delivered re-encoded and the codec never changes. This is the mode kept
    // behind `perTrack: false` since per-track delivery became the default.
    const unify = { perTrack: false };
    const dts = track({ number: 7, type: "audio", codecId: "A_DTS", audio: { sampleRate: 48000, channels: 2 } });
    const ac3 = track({ number: 8, type: "audio", codecId: "A_AC3", audio: { sampleRate: 48000, channels: 2 } });
    const file = { ...FILE, tracks: [VIDEO, dts, ac3] } as never;

    expect(unifiedAudioCodec(file, unify)).toBe("mp4a.40.2");
    expect(audioDelivery(ac3, undefined, unify)).toBe("copy");
    expect(audioDelivery(ac3, file, unify)).toBe("transcode");
    expect(plannedMimeTypes(VIDEO, ac3, file, unify).audio).toBe('audio/mp4; codecs="mp4a.40.2"');
    // And the track that was already going to be re-encoded is unaffected.
    expect(audioDelivery(dts, file, unify)).toBe("transcode");
  });

  it("delivers each track in its best form — per-track delivery", () => {
    // 21/09/2026: E-AC3 VF beside a TrueHD VO. Unified, the VF was re-encoded — a second lossy
    // generation of a track that played untouched the day before. Per track, the VF is copied and
    // the VO re-encoded; switching between them rebuilds the player, as every track change does.
    const eac3 = track({ number: 2, type: "audio", codecId: "A_EAC3", audio: { sampleRate: 48000, channels: 6 } });
    const trueHd = track({ number: 3, type: "audio", codecId: "A_TRUEHD", language: "eng", audio: { sampleRate: 48000, channels: 8 } });
    const dts = track({ number: 4, type: "audio", codecId: "A_DTS", language: "eng", audio: { sampleRate: 48000, channels: 6 } });
    const file = { ...FILE, tracks: [VIDEO, eac3, trueHd, dts] } as never;

    expect(unifiedAudioCodec(file)).toBeNull();
    expect(audioDelivery(eac3, file)).toBe("copy");
    expect(plannedMimeTypes(VIDEO, eac3, file).audio).toBe('audio/mp4; codecs="ec-3"');
    expect(audioDelivery(trueHd, file)).toBe("transcode");
    expect(audioDelivery(dts, file)).toBe("transcode");

    // The re-encoded tracks share a layout between them; the copied ones keep their own.
    expect(unifiedAudioChannels(file)).toBe(8);

    // Per-file unification, the other mode: the copied track is re-encoded too.
    expect(audioDelivery(eac3, file, { perTrack: false })).toBe("transcode");
    // Asked of one call, it leaves the next one — and every other pipeline — on the default.
    expect(audioDelivery(eac3, file)).toBe("copy");
  });

  it("leaves a file whose tracks already agree completely alone", () => {
    // Most of the library. Nothing is decoded that did not have to be.
    const one = track({ number: 7, type: "audio", codecId: "A_AC3", audio: { sampleRate: 48000, channels: 6 } });
    const two = track({ number: 8, type: "audio", codecId: "A_AC3", language: "eng", audio: { sampleRate: 48000, channels: 6 } });
    const file = { ...FILE, tracks: [VIDEO, one, two] } as never;

    expect(unifiedAudioCodec(file)).toBeNull();
    expect(audioDelivery(one, file)).toBe("copy");
  });

  it("refuses a re-encoded track this browser will not take back", async () => {
    // Safari, asked for AAC-LC, may answer with HE-AAC. Writing the profile that was asked for
    // over the description that came out produces an init segment that contradicts itself — and
    // Safari answers that by closing the MediaSource, taking the video buffer with it. Better to
    // find out here, where the old track is still playing.
    const dts = track({ number: 7, type: "audio", codecId: "A_DTS", audio: { sampleRate: 48000, channels: 6 } });
    FILE.tracks.push(dts);
    opened.length = 0;
    transcoderCodec = "mp4a.40.5";
    vi.stubGlobal("window", { ManagedMediaSource: { isTypeSupported: (t: string) => !t.includes("mp4a.40.5") } });

    try {
      await expect(Remuxer.open(SOURCE, FILE, VIDEO, dts, { width: 1920, height: 1080 })).rejects.toThrow(
        /n'accepte pas lui-même/
      );
      // And nothing is left running behind the refusal.
      expect(opened[0].closed).toBe(true);
    } finally {
      FILE.tracks.pop();
      transcoderCodec = "mp4a.40.2";
    }
  });

  it("names what the encoder produced, not what it was asked for", async () => {
    const dts = track({ number: 7, type: "audio", codecId: "A_DTS", audio: { sampleRate: 48000, channels: 6 } });
    FILE.tracks.push(dts);
    transcoderCodec = "mp4a.40.5";
    try {
      const remuxer = await Remuxer.open(SOURCE, FILE, VIDEO, dts, { width: 1920, height: 1080 });
      expect(remuxer.plan().audioMimeType).toBe('audio/mp4; codecs="mp4a.40.5"');
    } finally {
      FILE.tracks.pop();
      transcoderCodec = "mp4a.40.2";
    }
  });

  it("says an AC-3 track cannot be described when the file yields no frame to read", async () => {
    // The description lives in the bitstream, so an empty read is a real failure rather than a
    // reason to guess at the channel layout.
    const ac3 = track({ number: 2, type: "audio", codecId: "A_AC3", audio: { sampleRate: 48000, channels: 6 } });
    await expect(Remuxer.open(SOURCE, FILE, VIDEO, ac3, { width: 1920, height: 1080 })).rejects.toThrow(/AC-3/);
  });
});

/**
 * Les réglages d'une ouverture appartiennent à ce remultiplexeur, pas au module.
 *
 * Le plafond de lumière HDR était une variable de module, posée par `probePlaybackPath` avant
 * chaque ouverture et relue à chaque image. Deux chaînes vivent parfois ensemble — la
 * reconstruction qui relève un lecteur ouvre la nouvelle pendant que l'ancienne produit encore — et
 * la dernière ouverte imposait son réglage à l'autre.
 */
describe("les options d'ouverture", () => {
  // SEI préfixe « content light level » : MaxCLL 4451 (0x1163), MaxFALL 700 (0x02bc), puis l'IDR.
  const CLL = [0, 0, 0, 9, 39 << 1, 1, 144, 4, 0x11, 0x63, 0x02, 0xbc, 0x80];
  const picture = (): MediaSample => ({ ...idr(0), data: new Uint8Array([...CLL, 0, 0, 0, 3, 0x26, 0x01, 0xaf]) });
  const has = (haystack: Uint8Array, needle: number[]) =>
    haystack.some((_, i) => needle.every((b, j) => haystack[i + j] === b));
  // Le `HVCC` commun s'arrête avant `lengthSizeMinusOne` et se lit donc en longueurs d'un octet ;
  // celui-ci annonce les quatre octets que portent les images ci-dessus.
  const HEVC4 = track({ ...VIDEO, codecPrivate: new Uint8Array([...HVCC.subarray(0, 21), 0xff, 0]) });

  it("gardent à chaque remultiplexeur son propre plafond de lumière", async () => {
    readerSamples = [picture()];
    try {
      const dims = { width: 1920, height: 1080 };
      const capped = await Remuxer.open(SOURCE, FILE, HEVC4, null, dims, null, 0, { lightCapNits: 650 });
      // Ouvert après, sans plafond, pendant que le premier vit encore — une reconstruction, une
      // sonde : il n'a ni à lui retirer le sien, ni à en hériter.
      const natural = await Remuxer.open(SOURCE, FILE, HEVC4, null, dims);

      const cappedVideo = (await capped.nextSegment())!.video;
      const naturalVideo = (await natural.nextSegment())!.video;
      const bytes = (parts: Uint8Array[]) => new Uint8Array(parts.flatMap((p) => [...p]));

      // 650 = 0x028a, en MaxCLL comme en MaxFALL ; le second n'a pas été touché.
      expect(has(bytes(cappedVideo), [144, 4, 0x02, 0x8a, 0x02, 0x8a])).toBe(true);
      expect(has(bytes(naturalVideo), [144, 4, 0x11, 0x63, 0x02, 0xbc])).toBe(true);
    } finally {
      readerSamples = [];
    }
  });

  it("gardent à chaque remultiplexeur sa propre livraison audio", async () => {
    // DTS et AC-3 : unifiés, l'AC-3 serait ré-encodé ; livrés piste par piste, il est copié.
    const dts = track({ number: 7, type: "audio", codecId: "A_DTS", audio: { sampleRate: 48000, channels: 2 } });
    const ac3 = track({ number: 8, type: "audio", codecId: "A_AC3", audio: { sampleRate: 48000, channels: 2 } });
    const file = { ...FILE, tracks: [VIDEO, dts, ac3] } as MatroskaFile;
    const unified = await Remuxer.open(SOURCE, file, VIDEO, ac3, { width: 1920, height: 1080 }, null, 0, { perTrack: false });
    expect(unified.plan().audioMimeType).toBe('audio/mp4; codecs="mp4a.40.2"');
    expect(unified.diagnostics().transcodedAudio).toBe(true);
    // Et l'ouverture suivante, sans rien demander, revient au défaut.
    expect(plannedMimeTypes(VIDEO, ac3, file).audio).toBe('audio/mp4; codecs="ac-3"');
    unified.close();
  });
});

describe("plannedMimeTypes", () => {
  it("derives both codec strings from the headers alone, with no reading", () => {
    expect(plannedMimeTypes(VIDEO, AUDIO_FR)).toEqual({
      video: expect.stringMatching(/^video\/mp4; codecs="hvc1\./),
      audio: 'audio/mp4; codecs="mp4a.40.2"',
    });
    const avc = track({ number: 1, type: "video", codecId: "V_MPEG4/ISO/AVC", codecPrivate: AVCC });
    expect(plannedMimeTypes(avc, null)).toEqual({ video: 'video/mp4; codecs="avc1.640028"', audio: null });
  });

  it("returns nothing for a codec it cannot describe, rather than an invalid string", () => {
    expect(plannedMimeTypes(track({ number: 1, type: "video", codecId: "V_VP9" }), null).video).toBeNull();
    expect(plannedMimeTypes(VIDEO, track({ number: 2, type: "audio", codecId: "A_REAL/COOK" })).audio).toBeNull();
  });
});

describe("Remuxer encoder recovery", () => {
  it("rebuilds an encoder that fails rather than ending playback", async () => {
    // Safari's own AAC encoder gives up from time to time — "InternalAudioEncoderCocoa encoding
    // failed" — always after a change of track, never reproducibly. Nothing about the file or the
    // configuration is wrong, so a session must not end over someone else's hiccup.
    const dts = track({ number: 7, type: "audio", codecId: "A_DTS", audio: { sampleRate: 48000, channels: 2 } });
    FILE.tracks.push(dts);
    opened.length = 0;
    // Une image à lire : sans elle, le premier segment serait déjà la fin du son, qui ne se
    // reconstruit pas (voir « la fin du son » plus bas).
    readerSamples = [idr(0)];
    failNextFrames = true;

    try {
      const remuxer = await Remuxer.open(SOURCE, FILE, VIDEO, dts, { width: 1920, height: 1080 });
      await expect(remuxer.nextSegment()).resolves.not.toThrow();
      // A second transcoder was built, and the failed one released.
      expect(opened.length).toBe(2);
      expect(opened[0].closed).toBe(true);
    } finally {
      FILE.tracks.pop();
      failNextFrames = false;
      readerSamples = [];
    }
  });

  it("ne reconstruit pas l'encodeur pour une lecture coupée par un saut", async () => {
    // 22/09/2026 : un saut coupe les lectures réseau de la position quittée. Le transcodeur lit le
    // fichier lui-même ; une lecture coupée n'est pas une panne de l'encodeur à réparer.
    const { ReadAbandoned } = await import("@/lib/webcodecs/byteSource");
    const dts = track({ number: 7, type: "audio", codecId: "A_DTS", audio: { sampleRate: 48000, channels: 2 } });
    FILE.tracks.push(dts);
    opened.length = 0;
    framesHook = async () => {
      throw new ReadAbandoned();
    };
    try {
      const remuxer = await Remuxer.open(SOURCE, FILE, VIDEO, dts, { width: 1920, height: 1080 });
      const build = () => (remuxer as unknown as { buildTranscodedAudio(): Promise<unknown> }).buildTranscodedAudio();
      await expect(build()).rejects.toBeInstanceOf(ReadAbandoned);
      expect(opened.length).toBe(1);
      expect(opened[0].closed).toBe(false);
    } finally {
      FILE.tracks.pop();
      framesHook = null;
    }
  });

  it("ne compte pas une lecture coupée par un saut dans le budget de reconstructions de l'encodeur", async () => {
    // Chasse aux bugs du 22/09/2026 : chaque reconstruction interrompue par un saut usait le budget.
    const { ReadAbandoned } = await import("@/lib/webcodecs/byteSource");
    const dts = track({ number: 7, type: "audio", codecId: "A_DTS", audio: { sampleRate: 48000, channels: 2 } });
    FILE.tracks.push(dts);
    try {
      const remuxer = await Remuxer.open(SOURCE, FILE, VIDEO, dts, { width: 1920, height: 1080 });
      const { AudioTranscoder } = await import("@/lib/webcodecs/audioTranscode");
      const open = AudioTranscoder.open;
      (AudioTranscoder as unknown as { open: () => Promise<never> }).open = async () => {
        throw new ReadAbandoned();
      };
      const retry = (remuxer as unknown as { retryTranscoder: (e: unknown) => Promise<unknown>; encoderRestarts: number });
      for (let i = 0; i < 5; i++) await expect(retry.retryTranscoder(new Error("encodeur"))).rejects.toBeInstanceOf(ReadAbandoned);
      expect(retry.encoderRestarts).toBe(0);
      (AudioTranscoder as unknown as { open: typeof open }).open = open;
    } finally {
      FILE.tracks.pop();
    }
  });

  it("coupe les lectures d'ailleurs et lance celles du saut, dès la demande", async () => {
    const calls: string[] = [];
    const source = {
      ...SOURCE,
      abandon: (at: number) => calls.push(`abandon ${at}`),
      warm: (at: number) => calls.push(`warm ${at}`),
    } as unknown as ByteSource;
    const remuxer = await Remuxer.open(source, FILE, VIDEO, null, { width: 1920, height: 1080 });
    calls.length = 0;
    remuxer.prepareSeek(600);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^abandon /);
    expect(calls[1]).toBe(calls[0].replace("abandon", "warm"));
  });

  it("oublie les reconstructions après une minute de son sans échec, mais garde sa borne", async () => {
    // Trois reconstructions pour tout le film : un encodeur qui hoquette de loin en loin
    // épuisait ce crédit sur un long film, et le quatrième hoquet rendait le film au serveur.
    const dts = track({ number: 7, type: "audio", codecId: "A_DTS", audio: { sampleRate: 48000, channels: 2 } });
    FILE.tracks.push(dts);
    opened.length = 0;
    try {
      const remuxer = await Remuxer.open(SOURCE, FILE, VIDEO, dts, { width: 1920, height: 1080 });
      const build = () => (remuxer as unknown as { buildTranscodedAudio(): Promise<unknown> }).buildTranscodedAudio();
      for (let hiccup = 0; hiccup < 5; hiccup++) {
        failNextFrames = true;
        await expect(build()).resolves.not.toThrow();
        for (let good = 0; good < 30; good++) await build();
      }
      expect(opened.length).toBe(6);

      // Un encodeur qui échoue à chaque segment n'a jamais ses trente segments sains : la borne
      // tient, et c'est l'échec d'origine qui remonte.
      const always = await Remuxer.open(SOURCE, FILE, VIDEO, dts, { width: 1920, height: 1080 });
      const buildAlways = () => (always as unknown as { buildTranscodedAudio(): Promise<unknown> }).buildTranscodedAudio();
      for (let i = 0; i < 3; i++) {
        failNextFrames = true;
        await buildAlways();
      }
      failNextFrames = true;
      await expect(buildAlways()).rejects.toThrow(/Cocoa/);
    } finally {
      FILE.tracks.pop();
      failNextFrames = false;
    }
  });

  it("n'ouvre rien pour un remultiplexeur fermé pendant un segment", async () => {
    // Un segment en cours pendant close() échouait sur l'encodeur fermé ; la reconstruction
    // ouvrait alors un transcodeur neuf — un décodeur, un AudioEncoder — que plus personne ne
    // fermerait.
    const dts = track({ number: 7, type: "audio", codecId: "A_DTS", audio: { sampleRate: 48000, channels: 2 } });
    FILE.tracks.push(dts);
    opened.length = 0;
    readerSamples = [idr(0)];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    framesHook = async () => {
      await held;
      throw new Error("InvalidStateError: encoder closed");
    };
    try {
      const remuxer = await Remuxer.open(SOURCE, FILE, VIDEO, dts, { width: 1920, height: 1080 });
      const segment = remuxer.nextSegment();
      await new Promise((r) => setTimeout(r, 0));
      remuxer.close();
      release();
      await segment.catch(() => {});
      expect(opened.every((t) => t.closed)).toBe(true);
      expect(opened.length).toBe(1);
    } finally {
      FILE.tracks.pop();
      framesHook = null;
      readerSamples = [];
    }
  });
});

describe("la fin du fichier, son ré-encodé", () => {
  it("rend le reste du son une fois, puis dit que c'est fini", async () => {
    // `&& !this.transcoder` : avec un transcodeur, le fichier n'était jamais épuisé. Chaque appel
    // rendait un segment vide, endOfStream n'était jamais appelé, et au bout de huit segments
    // sans effet la source reprenait les trente dernières secondes — en boucle, dans le générique
    // de chaque film au son ré-encodé.
    const dts = track({ number: 7, type: "audio", codecId: "A_DTS", audio: { sampleRate: 48000, channels: 2 } });
    FILE.tracks.push(dts);
    readerSamples = [idr(0), idr(40_000)];
    const asked: number[] = [];
    framesHook = async (end) => {
      asked.push(end);
      // Une trame avant la fin de l'image, puis une après : la seconde n'appartient qu'à la fin.
      return end === Infinity
        ? [{ data: new Uint8Array([2]), timestampUs: 90_000, durationUs: 21_333 }]
        : [{ data: new Uint8Array([1]), timestampUs: 0, durationUs: 21_333 }];
    };
    try {
      const remuxer = await Remuxer.open(SOURCE, FILE, VIDEO, dts, { width: 1920, height: 1080 });
      const results = [];
      for (let i = 0; i < 6; i++) {
        const segment = await remuxer.nextSegment();
        results.push(segment);
        if (!segment) break;
      }
      // Les images et leur son, puis la fin du son seule, puis rien.
      expect(results).toHaveLength(3);
      expect(results[0]!.video.length).toBeGreaterThan(0);
      expect(results[0]!.audio).not.toBeNull();
      expect(results[1]!.video).toEqual([]);
      expect(results[1]!.audio).not.toBeNull();
      expect(results[2]).toBeNull();
      // Le son de la fin reprend là où celui des images s'arrête : même coupe, jusqu'au bout.
      expect(asked[0]).toBeCloseTo(results[0]!.endSeconds);
      expect(asked[1]).toBe(Infinity);
      expect(results[1]!.endSeconds).toBe(results[0]!.endSeconds);
    } finally {
      FILE.tracks.pop();
      framesHook = null;
      readerSamples = [];
    }
  });

  it("finit aussi quand la fin du son échoue, sans reconstruire l'encodeur", async () => {
    const dts = track({ number: 7, type: "audio", codecId: "A_DTS", audio: { sampleRate: 48000, channels: 2 } });
    FILE.tracks.push(dts);
    opened.length = 0;
    framesHook = async (end) => {
      if (end === Infinity) throw new Error("InternalAudioEncoderCocoa encoding failed");
      return [];
    };
    try {
      const remuxer = await Remuxer.open(SOURCE, FILE, VIDEO, dts, { width: 1920, height: 1080 });
      expect(await remuxer.nextSegment()).not.toBeNull();
      expect(await remuxer.nextSegment()).toBeNull();
      expect(opened).toHaveLength(1);
    } finally {
      FILE.tracks.pop();
      framesHook = null;
    }
  });

  it("recommence à lire après un saut, même une fois la fin atteinte", async () => {
    const dts = track({ number: 7, type: "audio", codecId: "A_DTS", audio: { sampleRate: 48000, channels: 2 } });
    FILE.tracks.push(dts);
    try {
      const remuxer = await Remuxer.open(SOURCE, FILE, VIDEO, dts, { width: 1920, height: 1080 });
      // Borné : sans le correctif, le fichier ne finit jamais.
      for (let i = 0; i < 6 && (await remuxer.nextSegment()); i++);
      remuxer.seekTo(10);
      // La fin du son est redemandée depuis la nouvelle position, puis la fin est redite.
      expect(await remuxer.nextSegment()).not.toBeNull();
      expect(await remuxer.nextSegment()).toBeNull();
    } finally {
      FILE.tracks.pop();
    }
  });
});

describe("Remuxer fragments", () => {
  it("cuts a keyframe group into fragments bounded by bytes and by count", async () => {
    // This library's keyframes sit anywhere from nothing to ten seconds apart, so one group can
    // be eight megabytes of pictures. Safari answers a nine-second, 228-sample, 5.5 MB append by
    // closing the MediaSource, the same bytes every time.
    const { __testing } = await import("@/lib/webcodecs/remuxer");
    // 200 samples of 5 kB: the count cap bites long before the byte cap.
    const many = __testing.planFragments(200, () => 5_000);
    expect(many.length).toBe(Math.ceil(200 / 60));
    expect(Math.max(...many.map((f) => f.length))).toBe(60);

    // 200 samples of 30 kB: now it is the bytes, at forty samples a fragment.
    const bulky = __testing.planFragments(200, () => 30_000);
    expect(Math.max(...bulky.map((f) => f.length))).toBe(40);

    // 20 samples of 300 kB: over the byte cap long before the sample cap.
    const heavy = __testing.planFragments(20, () => 300_000);
    expect(heavy.length).toBeGreaterThan(1);
    for (const fragment of heavy) {
      // Every fragment but a one-sample one stays under the cap.
      if (fragment.length > 1) expect(fragment.length * 300_000).toBeLessThanOrEqual(1_200_000 + 300_000);
    }

    // A single sample larger than the cap is still a fragment: a fragment of nothing is a loop.
    expect(__testing.planFragments(1, () => 9_000_000)).toEqual([[0]]);

    // Every sample lands in exactly one fragment, in order.
    const all = __testing.planFragments(137, (i) => (i % 7) * 40_000).flat();
    expect(all).toEqual(Array.from({ length: 137 }, (_, i) => i));
  });
});


describe("Remuxer streaming", () => {
  it("waits for the reordering depth, and no longer", async () => {
    const { __testing } = await import("@/lib/webcodecs/remuxer");
    // A fragment is 60 pictures. Before the depth is known, a generous guess stands in for it;
    // once measured, the wait is the depth plus a small margin. Either way it is a handful of
    // pictures, never the group — which on this library runs to twenty-five seconds.
    expect(__testing.settledAfter(null, null)).toBe(60 + 64 + 1);
    // 200 ms of reordering at 40 ms a picture: five, plus four of margin.
    expect(__testing.settledAfter(200_000, 40_000)).toBe(60 + 9 + 1);
    // A depth beyond anything a real encoder produces is capped at the guess rather than trusted.
    expect(__testing.settledAfter(100_000_000, 40_000)).toBe(60 + 64 + 1);
  });
});

// Un index qui désigne une image où l'on ne peut pas commencer (une TRAIL_R marquée clé, comme
// Utopia) : le remultiplexeur recule pour trouver la vraie. Sous douze secondes, il abandonnait au
// lieu de repartir du début (relu le 24/09/2026).
describe("reculer dans l'index près du début", () => {
  const trailing = (timestampUs: number): MediaSample => ({
    trackNumber: 1,
    timestampUs,
    durationUs: 40_000,
    isKey: true,
    // Longueurs sur un octet : c'est ce que dit l'en-tête HVCC de ce banc (octet 21 à zéro).
    data: new Uint8Array([3, 0x02, 0x01, 0xaf]),
  });

  it("repart du début du fichier pour une cible sous douze secondes", async () => {
    readerSamples = [trailing(9_000_000), idr(20_000_000)];
    readerSeeks.length = 0;
    const remuxer = await open(null);
    remuxer.seekTo(8);
    const before = readerSeeks.length;
    await remuxer.nextSegment();
    expect(readerSeeks.length).toBeGreaterThan(before);
    expect(readerSeeks.at(-1)).toBe(FILE.firstClusterOffset);
    readerSamples = [];
  });
});


/**
 * Des blocs audio aux horodatages bousculés : « The Proposal » (balayage du 24/09/2026), AC-3 de
 * 32 ms arrondis à la milliseconde, parfois un peu en arrière du précédent, une fois 22 ms en
 * arrière (968,639 s puis 968,617 s). L'écart négatif devenait une durée de 1 µs : les temps
 * implicites du fragment glissaient d'autant, et le fragment suivant commençait avant la fin du
 * précédent — un temps de décodage qui recule, que ffmpeg refuse.
 */
describe("des horodatages audio qui reculent", () => {
  const aac = (timestampUs: number): MediaSample => ({
    trackNumber: 2,
    timestampUs,
    durationUs: 32_000,
    isKey: true,
    data: new Uint8Array([0x21, 0x10, 0x04]),
  });

  /** tfdt et durées du trun d'un segment : sa première instant et sa fin implicite. */
  function span(segment: Uint8Array): { start: number; end: number } {
    const view = new DataView(segment.buffer, segment.byteOffset, segment.byteLength);
    const find = (type: string) => {
      for (let i = 0; i + 8 <= segment.length; i++) {
        if (String.fromCharCode(...segment.subarray(i + 4, i + 8)) === type) return i;
      }
      throw new Error(`${type} absent`);
    };
    const tfdt = find("tfdt");
    const start = Number(view.getBigUint64(tfdt + 12));
    const trun = find("trun");
    const count = view.getUint32(trun + 12);
    let end = start;
    for (let s = 0; s < count; s++) end += view.getUint32(trun + 20 + s * 16);
    return { start, end };
  }

  it("ne fait jamais commencer un segment audio avant la fin du précédent", async () => {
    const video = Array.from({ length: 120 }, (_, i) => idr(i * 100_000));
    // Une trame de 32 ms, avec le bruit du fichier : ±3 ms, et un recul franc de 22 ms.
    const jitter = [0, 1_000, -2_000, 3_000, -1_000, 2_000, -3_000, 0];
    const audio = Array.from({ length: 360 }, (_, i) => aac(i * 32_000 + Math.max(0, jitter[i % 8] + 3_000)));
    audio[180] = aac(audio[179].timestampUs - 22_000);
    // Rangés comme dans une grappe : par horodatage, pistes mêlées.
    readerSamples = [...video, ...audio].sort((a, b) => a.timestampUs - b.timestampUs);
    const remuxer = await open();
    const spans: { start: number; end: number }[] = [];
    for (let i = 0; i < 40; i++) {
      const segment = await remuxer.nextSegment();
      if (!segment) break;
      if (segment.audio) spans.push(span(segment.audio));
    }
    readerSamples = [];
    expect(spans.length).toBeGreaterThan(2);
    for (let i = 1; i < spans.length; i++) expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
  });
});
