import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from "vitest";
import {
  Remuxer, unifiedAudioCodec, audioDelivery, plannedMimeTypes, playableAudio, remuxableAudio,
  setPerTrackAudioDelivery, deliveredAudio, audioSwitchNeedsRebuild, setAudioBufferRebuildable, unifiedAudioChannels,
} from "@/lib/webcodecs/remuxer";
import type { MatroskaFile, MatroskaTrack, MediaSample } from "@/lib/webcodecs/matroska";
import type { ByteSource } from "@/lib/webcodecs/byteSource";

// A stand-in transcoder, so the one property that matters here can be checked: what is released,
// and when. The real one needs a decoder and an encoder that exist only in a browser.
const opened: { closed: boolean }[] = [];
let openFails = false;
let transcoderCodec = "mp4a.40.2";
let transcoderRate = 48000;
let failNextFrames = false;
/** Ce que rend `framesUpTo`, et où on le lui a demandé — par défaut, rien. */
let framesHook: ((endSeconds: number) => Promise<{ data: Uint8Array; timestampUs: number; durationUs: number }[]>) | null = null;
/** Retardé à volonté, pour fermer le remultiplexeur pendant une ouverture. */
let openGate: Promise<void> | null = null;
vi.mock("@/lib/webcodecs/audioTranscode", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/webcodecs/audioTranscode")>();
  return {
    ...original,
    AudioTranscoder: {
      open: async () => {
        if (openFails) throw new Error("l'encodeur a refusé");
        if (openGate) await openGate;
        const instance = {
          closed: false,
          codecString: transcoderCodec,
          sampleEntry: new Uint8Array([0, 0, 0, 8, 0x6d, 0x70, 0x34, 0x61]),
          sampleRate: transcoderRate,
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
vi.mock("@/lib/webcodecs/sampleReader", () => ({
  SampleReader: class {
    private queue = [...readerSamples];
    async next() {
      return this.queue.shift() ?? null;
    }
    seekTo() {}
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
    // behind setPerTrackAudioDelivery(false) since per-track delivery became the default.
    setPerTrackAudioDelivery(false);
    onTestFinished(() => setPerTrackAudioDelivery(true));
    const dts = track({ number: 7, type: "audio", codecId: "A_DTS", audio: { sampleRate: 48000, channels: 2 } });
    const ac3 = track({ number: 8, type: "audio", codecId: "A_AC3", audio: { sampleRate: 48000, channels: 2 } });
    const file = { ...FILE, tracks: [VIDEO, dts, ac3] } as never;

    expect(unifiedAudioCodec(file)).toBe("mp4a.40.2");
    expect(audioDelivery(ac3)).toBe("copy");
    expect(audioDelivery(ac3, file)).toBe("transcode");
    expect(plannedMimeTypes(VIDEO, ac3, file).audio).toBe('audio/mp4; codecs="mp4a.40.2"');
    // And the track that was already going to be re-encoded is unaffected.
    expect(audioDelivery(dts, file)).toBe("transcode");
  });

  it("delivers each track in its best form, and says which changes need a rebuild — per-track delivery", () => {
    // Braveheart, 21/09/2026: E-AC3 VF beside a TrueHD VO. Unified, the VF was re-encoded — a
    // second lossy generation of a track that played untouched the day before. Per track, the VF
    // is copied, the VO re-encoded, and switching between them rebuilds the player.
    const eac3 = track({ number: 2, type: "audio", codecId: "A_EAC3", audio: { sampleRate: 48000, channels: 6 } });
    const trueHd = track({ number: 3, type: "audio", codecId: "A_TRUEHD", language: "eng", audio: { sampleRate: 48000, channels: 8 } });
    const dts = track({ number: 4, type: "audio", codecId: "A_DTS", language: "eng", audio: { sampleRate: 48000, channels: 6 } });
    const eac3Eng = track({ number: 5, type: "audio", codecId: "A_EAC3", language: "eng", audio: { sampleRate: 48000, channels: 2 } });
    const ac3 = track({ number: 6, type: "audio", codecId: "A_AC3", language: "eng", audio: { sampleRate: 48000, channels: 6 } });
    const file = { ...FILE, tracks: [VIDEO, eac3, trueHd, dts, eac3Eng, ac3] } as never;

    expect(unifiedAudioCodec(file)).toBeNull();
    expect(audioDelivery(eac3, file)).toBe("copy");
    expect(plannedMimeTypes(VIDEO, eac3, file).audio).toBe('audio/mp4; codecs="ec-3"');
    expect(deliveredAudio(eac3, file)).toBe("ec-3");
    expect(deliveredAudio(trueHd, file)).toBe("ré-encodé 48000 Hz");

    // A change of delivered format rebuilds; the same format keeps the fast buffer change —
    // including two re-encoded tracks (one codec, one layout) and two E-AC3 of different layouts,
    // measured fine on an iPhone ("2001", 6 → 2 channels, 0.1 to 0.8 s).
    expect(audioSwitchNeedsRebuild(file, eac3, trueHd)).toBe(true);
    expect(audioSwitchNeedsRebuild(file, trueHd, eac3)).toBe(true);
    expect(audioSwitchNeedsRebuild(file, eac3, ac3)).toBe(true);
    expect(audioSwitchNeedsRebuild(file, trueHd, dts)).toBe(false);
    expect(audioSwitchNeedsRebuild(file, eac3, eac3Eng)).toBe(false);

    // The re-encoded tracks share a layout between them; the copied ones keep their own.
    expect(unifiedAudioChannels(file)).toBe(8);

    // Neither mode that makes formats agree ever asks for a rebuild.
    setPerTrackAudioDelivery(false);
    expect(audioSwitchNeedsRebuild(file, eac3, trueHd)).toBe(false);
    setPerTrackAudioDelivery(true);
    setAudioBufferRebuildable(true);
    expect(audioSwitchNeedsRebuild(file, eac3, trueHd)).toBe(false);
    setAudioBufferRebuildable(false);
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

  it("keeps the track it has, and the machinery for it, when a change fails", async () => {
    // Start on a track that is being re-encoded, so there is something to lose.
    const dts = track({ number: 7, type: "audio", codecId: "A_DTS", audio: { sampleRate: 48000, channels: 6 } });
    const otherDts = track({ ...dts, number: 8, language: "eng" });
    FILE.tracks.push(dts, otherDts);
    opened.length = 0;
    openFails = false;

    try {
      const remuxer = await Remuxer.open(SOURCE, FILE, VIDEO, dts, { width: 1920, height: 1080 });
      expect(opened).toHaveLength(1);
      const before = remuxer.plan().audioMimeType;

      // Releasing the working one first and then failing to open its replacement leaves nothing
      // able to produce sound: no segments, a buffer that never advances, and a player loading
      // for ever with nothing to say for itself.
      openFails = true;
      await expect(remuxer.setAudioTrack(otherDts.number)).rejects.toThrow();
      expect(opened[0].closed).toBe(false);
      expect(remuxer.plan().audioMimeType).toBe(before);
    } finally {
      FILE.tracks.splice(-2, 2);
      openFails = false;
    }
  });

  it("says an AC-3 track cannot be described when the file yields no frame to read", async () => {
    // The description lives in the bitstream, so an empty read is a real failure rather than a
    // reason to guess at the channel layout.
    const ac3 = track({ number: 2, type: "audio", codecId: "A_AC3", audio: { sampleRate: 48000, channels: 6 } });
    await expect(Remuxer.open(SOURCE, FILE, VIDEO, ac3, { width: 1920, height: 1080 })).rejects.toThrow(/AC-3/);
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

      // Et une piste qui finit de s'ouvrir après la fermeture est refermée aussitôt.
      framesHook = null;
      const other = await Remuxer.open(SOURCE, FILE, VIDEO, dts, { width: 1920, height: 1080 });
      const otherDts = track({ ...dts, number: 8, language: "eng" });
      FILE.tracks.push(otherDts);
      let open!: () => void;
      openGate = new Promise<void>((resolve) => (open = resolve));
      const switching = other.setAudioTrack(otherDts.number);
      await new Promise((r) => setTimeout(r, 0));
      other.close();
      open();
      await expect(switching).rejects.toThrow();
      expect(opened.every((t) => t.closed)).toBe(true);
      FILE.tracks.pop();
    } finally {
      FILE.tracks.pop();
      framesHook = null;
      openGate = null;
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

describe("pistes ré-encodées de fréquences différentes", () => {
  it("demande une reconstruction plutôt que de changer la fréquence d'un tampon vivant", () => {
    // Deux pistes « ré-encodées » : l'encodeur prend la fréquence du décodeur, et elle est écrite
    // dans le segment d'initialisation. Un FLAC à 44,1 kHz après un DTS à 48 kHz, c'était une
    // autre configuration dans le même tampon.
    vi.stubGlobal("window", { ManagedMediaSource: { isTypeSupported: (t: string) => t.includes("mp4a") } });
    const flac = track({ number: 2, type: "audio", codecId: "A_FLAC", audio: { sampleRate: 44100, channels: 2 } });
    const dts = track({ number: 3, type: "audio", codecId: "A_DTS", language: "eng", audio: { sampleRate: 48000, channels: 2 } });
    const dts2 = track({ number: 4, type: "audio", codecId: "A_DTS", language: "spa", audio: { sampleRate: 48000, channels: 2 } });
    const file = { ...FILE, tracks: [VIDEO, flac, dts, dts2] } as never;

    expect(audioSwitchNeedsRebuild(file, dts, flac)).toBe(true);
    expect(audioSwitchNeedsRebuild(file, flac, dts)).toBe(true);
    expect(audioSwitchNeedsRebuild(file, dts, dts2)).toBe(false);
  });

  it("refuse un changement dont l'encodeur sort à une autre fréquence, et garde la piste d'avant", async () => {
    // Le filet, pour ce que l'en-tête du fichier n'a pas su dire — et pour l'unification par
    // fichier, où rien ne reconstruit.
    const dts = track({ number: 7, type: "audio", codecId: "A_DTS", audio: { sampleRate: 48000, channels: 6 } });
    const other = track({ ...dts, number: 8, language: "eng" });
    FILE.tracks.push(dts, other);
    opened.length = 0;
    try {
      const remuxer = await Remuxer.open(SOURCE, FILE, VIDEO, dts, { width: 1920, height: 1080 });
      transcoderRate = 44100;
      await expect(remuxer.setAudioTrack(other.number)).rejects.toThrow(/44100 Hz/);
      expect(opened[0].closed).toBe(false);
      expect(opened[1].closed).toBe(true);
    } finally {
      FILE.tracks.splice(-2, 2);
      transcoderRate = 48000;
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
