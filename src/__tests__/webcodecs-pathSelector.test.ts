import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { choosePlaybackPath, describePath, type PathInput } from "@/lib/webcodecs/pathSelector";
import type { MatroskaFile, MatroskaTrack } from "@/lib/webcodecs/matroska";
import {
  MemoryByteSource,
  NetworkUnavailable,
  ReadAbandoned,
  isNetworkFailure,
  isReadAbandoned,
  type ByteSource,
} from "@/lib/webcodecs/byteSource";
import { readFileSync } from "fs";
import { Remuxer, plannedMimeTypes } from "@/lib/webcodecs/remuxer";

// A real hvcC: Main profile, level 120. The selector reads it to build the codec string it then
// asks the browser about, so a placeholder would not exercise the decision at all.
const HVCC = new Uint8Array([
  1, 1, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0x78, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, 0,
]);
const AAC_CONFIG = new Uint8Array([0x11, 0x90]); // AAC-LC, 48 kHz, stereo

function track(overrides: Partial<MatroskaTrack> & Pick<MatroskaTrack, "number" | "type" | "codecId">): MatroskaTrack {
  return {
    codecPrivate: null, language: "fra", name: null,
    isDefault: true, isForced: false, isHearingImpaired: false, isEnabled: true, defaultDurationNs: null,
    ...overrides,
  };
}

const VIDEO = track({ number: 1, type: "video", codecId: "V_MPEGH/ISO/HEVC", codecPrivate: HVCC, video: { width: 1920, height: 1080 } });
const AAC = track({ number: 2, type: "audio", codecId: "A_AAC", codecPrivate: AAC_CONFIG, audio: { sampleRate: 48000, channels: 2 } });
const EAC3 = track({ number: 2, type: "audio", codecId: "A_EAC3", audio: { sampleRate: 48000, channels: 6 } });

function input(video = VIDEO, audio: MatroskaTrack | null = AAC): PathInput {
  const file: MatroskaFile = {
    timestampScaleNs: 1_000_000, durationSeconds: 3600,
    tracks: [video, ...(audio ? [audio] : [])], cues: [],
    segmentDataStart: 0, segmentEnd: 1000, firstClusterOffset: 0,
  };
  const source: ByteSource = { size: 1000, read: async () => new Uint8Array(0), close: () => {} };
  return { source, file, videoTrack: video, audioTrack: audio, dimensions: { width: 1920, height: 1080 } };
}

/** Derived, not hand-written: this suite is about the decision, not about codec-string syntax. */
function mimeFor(video: MatroskaTrack, audio: MatroskaTrack | null) {
  const mime = plannedMimeTypes(video, audio);
  return { video: mime.video!, audio: mime.audio };
}

// The transcoder itself needs a decoder and an encoder that only exist in a browser. What is
// being checked here is the decision — whether a track the player will not take is re-encoded
// rather than costing the hardware path — so the machinery behind it is stood in for.
vi.mock("@/lib/webcodecs/audioTranscode", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/webcodecs/audioTranscode")>();
  return {
    ...original,
    AudioTranscoder: {
      open: async () => ({
        sampleEntry: new Uint8Array([0, 0, 0, 8, 0x6d, 0x70, 0x34, 0x61]),
        codecString: "mp4a.40.2",
        sampleRate: 48000,
        channels: 6,
        seekTo: () => {},
        framesUpTo: async () => [],
        close: () => {},
      }),
    },
  };
});

let supported = new Set<string>();
beforeEach(() => {
  supported = new Set();
  vi.stubGlobal("window", { ManagedMediaSource: { isTypeSupported: (t: string) => supported.has(t) } });
});
afterEach(() => vi.unstubAllGlobals());

describe("choosePlaybackPath", () => {
  it("prefers remuxing when the browser accepts both codecs", async () => {
    const mime = mimeFor(VIDEO, AAC);
    supported = new Set([mime.video, mime.audio!]);
    const chosen = await choosePlaybackPath(input());

    // The native path decodes in hardware and shows HDR without a shader; it is preferred
    // whenever it is available at all, not only when the other one fails.
    expect(chosen.path).toBe("remux");
    expect(chosen.remuxer).not.toBeNull();
    expect(chosen.plan?.videoMimeType).toBe(mime.video);
    expect(chosen.attempts).toEqual([{ path: "remux", ok: true }]);
  });

  it("re-encodes audio the browser will not take, rather than giving up the hardware path", async () => {
    // Chrome ships no Dolby decoder, so it takes neither AC-3 nor E-AC-3 in a container — and
    // that is most of this library. Losing hardware video over the sound would be the wrong
    // trade when the sound can simply be handed over as something else.
    supported = new Set([mimeFor(VIDEO, null).video, 'audio/mp4; codecs="mp4a.40.2"']);
    vi.stubGlobal("AudioEncoder", { isConfigSupported: async () => ({ supported: true }) });

    const chosen = await choosePlaybackPath(input(VIDEO, EAC3));
    expect(chosen.path).toBe("remux");
    expect(chosen.plan?.audioMimeType).toBe('audio/mp4; codecs="mp4a.40.2"');
  });

  it("steps down to WebCodecs when it can neither carry nor re-encode the audio", async () => {
    supported = new Set([mimeFor(VIDEO, null).video]);
    vi.stubGlobal("AudioEncoder", undefined);
    const chosen = await choosePlaybackPath(input(VIDEO, EAC3));

    expect(chosen.path).toBe("webcodecs");
    expect(chosen.remuxer).toBeNull();
    expect(chosen.attempts[0]).toMatchObject({ path: "remux", ok: false });
    expect(chosen.attempts[0].reason).toContain("A_EAC3");
    expect(chosen.attempts[1]).toEqual({ path: "webcodecs", ok: true });
  });

  it("steps down when the container holds a codec the remuxer cannot describe", async () => {
    const supportedMime = mimeFor(VIDEO, AAC);
    supported = new Set([supportedMime.video, supportedMime.audio!]);
    const dts = track({ number: 2, type: "audio", codecId: "A_DTS", audio: { sampleRate: 48000, channels: 6 } });
    const chosen = await choosePlaybackPath(input(VIDEO, dts));

    expect(chosen.path).toBe("webcodecs");
    expect(chosen.attempts[0].reason).toContain("A_DTS");
  });

  it("steps down when the browser accepts nothing at all", async () => {
    vi.stubGlobal("AudioEncoder", undefined);
    const chosen = await choosePlaybackPath(input());
    expect(chosen.path).toBe("webcodecs");
    expect(chosen.attempts[0]).toMatchObject({ path: "remux", ok: false });
    expect(chosen.attempts[1]).toEqual({ path: "webcodecs", ok: true });
  });

  it("refuses out loud when neither path can carry the file, naming both reasons", async () => {
    // MPEG-2 is in no browser's WebCodecs and cannot be described in an MP4 sample entry here.
    const mpeg2 = track({ number: 1, type: "video", codecId: "V_MPEG2", video: { width: 720, height: 576 } });
    await expect(choosePlaybackPath(input(mpeg2, AAC))).rejects.toThrow(/V_MPEG2/);
    // Both refusals appear, so the panel can show the whole chain rather than only the last step.
    await expect(choosePlaybackPath(input(mpeg2, AAC))).rejects.toThrow(/remux[\s\S]*webcodecs/);
  });

  it("treats a file with no audio track as remuxable", async () => {
    supported = new Set([mimeFor(VIDEO, null).video]);
    const chosen = await choosePlaybackPath(input(VIDEO, null));
    expect(chosen.path).toBe("remux");
    expect(chosen.plan?.audioMimeType).toBeNull();
  });
});

/**
 * Chasse aux défauts du 22/09/2026 : le `catch` autour de `Remuxer.open` changeait toute erreur en
 * refus de chemin (« pas par ici, essayez le suivant »). Une coupure du Wi-Fi pendant l'ouverture
 * envoyait donc le film au canevas — ou au lecteur serveur, qui a besoin du même réseau —, et une
 * reconstruction pour un changement de piste répondait « piste refusée ». Le réseau et la lecture
 * abandonnée ne disent rien du chemin : ils remontent tels quels, jusqu'à l'écran « connexion
 * perdue » de l'hôte.
 */
describe("une ouverture interrompue par le réseau", () => {
  afterEach(() => vi.restoreAllMocks());

  it("remonte une panne réseau au lieu de descendre au canevas", async () => {
    const mime = mimeFor(VIDEO, AAC);
    supported = new Set([mime.video, mime.audio!]);
    vi.spyOn(Remuxer, "open").mockRejectedValueOnce(new NetworkUnavailable("Plage inaccessible : Failed to fetch"));
    const failure = await choosePlaybackPath(input()).then(
      () => null,
      (error: unknown) => error
    );
    expect(isNetworkFailure(failure)).toBe(true);
  });

  it("remonte une lecture abandonnée telle quelle", async () => {
    const mime = mimeFor(VIDEO, AAC);
    supported = new Set([mime.video, mime.audio!]);
    vi.spyOn(Remuxer, "open").mockRejectedValueOnce(new ReadAbandoned());
    const failure = await choosePlaybackPath(input()).then(
      () => null,
      (error: unknown) => error
    );
    expect(isReadAbandoned(failure)).toBe(true);
  });

  it("une autre erreur reste un refus de ce chemin", async () => {
    const mime = mimeFor(VIDEO, AAC);
    supported = new Set([mime.video, mime.audio!]);
    vi.spyOn(Remuxer, "open").mockRejectedValueOnce(new Error("en-tête incohérent"));
    const chosen = await choosePlaybackPath(input());
    expect(chosen.path).toBe("webcodecs");
    expect(describePath(chosen)).toContain("en-tête incohérent");
  });
});

/**
 * Un fichier tout en TrueHD — Top Gun Maverick, Sinners, American Sniper.
 *
 * Jusqu'au 21/09/2026, aucun décodeur n'existait nulle part : un tel fichier était cédé d'office au
 * lecteur serveur, sans essayer le canevas qui aurait échoué sur la même chose (« American
 * Sniper », 20/09/2026, 250 à 700 ms perdues par tentative). Le décodeur de FFmpeg, compilé en
 * WebAssembly, en fait maintenant un fichier comme un autre : son ré-encodé comme le DTS.
 */
describe("un fichier tout en TrueHD", () => {
  const TRUEHD = track({ number: 2, type: "audio", codecId: "A_TRUEHD", audio: { sampleRate: 48000, channels: 8 } });

  it("prend le chemin natif, le son ré-encodé", async () => {
    supported = new Set([mimeFor(VIDEO, null).video, 'audio/mp4; codecs="mp4a.40.2"']);
    vi.stubGlobal("AudioEncoder", { isConfigSupported: async () => ({ supported: true }) });
    const chosen = await choosePlaybackPath(input(VIDEO, TRUEHD));
    expect(chosen.path).toBe("remux");
    expect(chosen.plan?.audioMimeType).toBe('audio/mp4; codecs="mp4a.40.2"');
  });

  it("et, sans encodeur, laisse sa chance au canevas au lieu de le céder au serveur", async () => {
    supported = new Set([mimeFor(VIDEO, null).video]);
    vi.stubGlobal("AudioEncoder", undefined);
    const chosen = await choosePlaybackPath(input(VIDEO, TRUEHD));
    expect(chosen.path).toBe("webcodecs");
  });
});

/**
 * Une piste que rien ne décode : le MP2 de « Des gens bien » (balayage du 24/09/2026). Le canevas
 * l'essayait pour échouer sur « Pas de son », avant que le lecteur serveur ne prenne la main.
 */
describe("un son que rien ne décode", () => {
  const MP2 = track({ number: 2, type: "audio", codecId: "A_MPEG/L2", audio: { sampleRate: 48000, channels: 2 } });

  it("passe directement au lecteur serveur, sans essayer le canevas", async () => {
    supported = new Set([mimeFor(VIDEO, null).video]);
    vi.stubGlobal("AudioEncoder", { isConfigSupported: async () => ({ supported: true }) });
    await expect(choosePlaybackPath(input(VIDEO, MP2))).rejects.toThrow(/A_MPEG\/L2 : aucun décodeur/);
  });

  it("mais un AAC sans configuration garde sa chance au canevas", async () => {
    supported = new Set([mimeFor(VIDEO, null).video]);
    vi.stubGlobal("AudioEncoder", undefined);
    const bare = track({ number: 2, type: "audio", codecId: "A_AAC", audio: { sampleRate: 48000, channels: 2 } });
    const chosen = await choosePlaybackPath(input(VIDEO, bare));
    expect(chosen.path).toBe("webcodecs");
  });
});

describe("describePath", () => {
  it("names the path taken, and every one refused before it", async () => {
    supported = new Set([mimeFor(VIDEO, null).video]);
    expect(describePath(await choosePlaybackPath(input(VIDEO, null)))).toBe("remultiplexage → lecteur natif");

    vi.stubGlobal("AudioEncoder", undefined);
    const stepped = await choosePlaybackPath(input(VIDEO, EAC3));
    const described = describePath(stepped);
    expect(described).toContain("WebCodecs → canvas");
    expect(described).toContain("remux refusé");
    expect(described).toContain("A_EAC3");
  });
});

describe("le conteneur du navigateur", () => {
  /** A source holding only a header, which is all the detection reads. */
  const sourceOf = (head: number[]) => ({
    size: head.length,
    read: async (offset: number, length: number) =>
      new Uint8Array(head.slice(offset, Math.min(offset + length, head.length))),
    close: vi.fn(),
  });

  const ebml = [0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01, 0, 0, 0];

  it("fait passer un MP4 par le remultiplexage, comme un Matroska", async () => {
    // Il était remis tel quel à <video> : un bon conteneur ne dit pas que tout se lit nativement
    // — E-AC3 muet sur Chrome, ni menu de pistes ni sous-titres. Il suit désormais le même
    // chemin que le reste, qui ne fait rien (ou presque) quand rien n'est à faire.
    const bytes = new Uint8Array(readFileSync("src/__tests__/fixtures/mp4/c-hevc-multi.mp4"));
    vi.resetModules();
    vi.doMock("@/lib/webcodecs/byteSource", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/webcodecs/byteSource")>()),
      HttpByteSource: { open: async () => new MemoryByteSource(bytes) },
    }));
    vi.stubGlobal("window", { ManagedMediaSource: { isTypeSupported: () => true } });
    const { probePlaybackPath } = await import("@/lib/webcodecs/remuxPlayback");
    const probe = await probePlaybackPath({
      streamUrl: "/film.mp4",
      startSeconds: 0,
      onError: vi.fn(),
      // La langue du compte est honorée, ce que la lecture directe ne savait pas faire.
      audioPreferences: { audioLanguage: "fra", subtitleLanguage: null, subtitleMode: "Default", playDefaultAudioTrack: false },
    });
    expect(probe.path).toBe("remux");
    if (probe.path !== "remux") return;
    expect(probe.chosen.plan?.videoMimeType).toMatch(/hvc1/);
    expect(probe.chosen.plan?.audioMimeType).toBe('audio/mp4; codecs="ac-3"');
    probe.discard();
    vi.doUnmock("@/lib/webcodecs/byteSource");
  });

  it("refuse un MP4 fragmenté par une erreur — que l'appelant confie au lecteur serveur", async () => {
    const bytes = new Uint8Array(readFileSync("src/__tests__/fixtures/mp4/d-fragmented.mp4"));
    const close = vi.fn();
    vi.resetModules();
    vi.doMock("@/lib/webcodecs/byteSource", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/webcodecs/byteSource")>()),
      HttpByteSource: { open: async () => Object.assign(new MemoryByteSource(bytes), { close }) },
    }));
    const { probePlaybackPath } = await import("@/lib/webcodecs/remuxPlayback");
    await expect(probePlaybackPath({ streamUrl: "/film.mp4", startSeconds: 0, onError: vi.fn() })).rejects.toThrow(/fragmenté/);
    // La connexion n'a plus d'usage : fermée, pas abandonnée.
    expect(close).toHaveBeenCalled();
    vi.doUnmock("@/lib/webcodecs/byteSource");
  });

  it("ferme la source quand le choix du chemin échoue, et laisse passer la panne réseau", async () => {
    // Chasse aux défauts du 22/09/2026 : seule une erreur d'en-tête refermait la source. Un choix
    // de chemin qui levait — réseau coupé, refus au profit du lecteur serveur — la laissait
    // ouverte, avec sa lecture en avance, pour un film que plus personne ne lisait.
    const bytes = new Uint8Array(readFileSync("src/__tests__/fixtures/mp4/c-hevc-multi.mp4"));
    const close = vi.fn();
    vi.resetModules();
    vi.doMock("@/lib/webcodecs/byteSource", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/webcodecs/byteSource")>()),
      HttpByteSource: { open: async () => Object.assign(new MemoryByteSource(bytes), { close }) },
    }));
    vi.doMock("@/lib/webcodecs/pathSelector", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/webcodecs/pathSelector")>()),
      choosePlaybackPath: async () => {
        throw new NetworkUnavailable("Plage inaccessible : Failed to fetch");
      },
    }));
    const { probePlaybackPath } = await import("@/lib/webcodecs/remuxPlayback");
    const failure = await probePlaybackPath({ streamUrl: "/film.mp4", startSeconds: 0, onError: vi.fn() }).then(
      () => null,
      (error: unknown) => error
    );
    // L'hôte reconnaît la panne réseau (`isNetworkFailure`) et montre « connexion perdue ».
    expect(isNetworkFailure(failure)).toBe(true);
    expect(close).toHaveBeenCalled();
    vi.doUnmock("@/lib/webcodecs/pathSelector");
    vi.doUnmock("@/lib/webcodecs/byteSource");
  });

  it("ne prend pas un Matroska pour l'un d'eux", async () => {
    vi.resetModules();
    vi.doMock("@/lib/webcodecs/byteSource", () => ({
      HttpByteSource: { open: async () => sourceOf(ebml) },
    }));
    const { probePlaybackPath } = await import("@/lib/webcodecs/remuxPlayback");
    // It goes on to parse, and this stub has nothing to parse — which is a different failure
    // from being taken for an MP4.
    await expect(
      probePlaybackPath({ streamUrl: "/film.mkv", startSeconds: 0, onError: vi.fn() })
    ).rejects.toThrow();
    vi.doUnmock("@/lib/webcodecs/byteSource");
  });
});
