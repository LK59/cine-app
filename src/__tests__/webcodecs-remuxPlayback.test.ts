import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ByteSource } from "@/lib/webcodecs/byteSource";
import type { MatroskaFile, MatroskaTrack } from "@/lib/webcodecs/matroska";
import type { ChosenPath } from "@/lib/webcodecs/pathSelector";
import type { Remuxer, RemuxPlan } from "@/lib/webcodecs/remuxer";

// Un changement de piste sur un fichier sans index. Les deux façons de changer de piste repartent
// de la position courante *par l'index* ; sans index, le rechargement du son relisait le film
// depuis son premier octet, et la reconstruction le reprenait à zéro.

const mse = vi.hoisted(() => ({
  runExclusive: vi.fn(async (action: () => Promise<unknown>) => action()),
  replaceAudio: vi.fn(async () => {}),
  refillAudio: vi.fn(async () => {}),
  seek: vi.fn(async () => {}),
  beginAudioHold: vi.fn(),
  releaseAudioHold: vi.fn(),
  armAudioRelease: vi.fn(async () => {}),
  destroy: vi.fn(),
  presentationDelay: 0,
  rebuildAudioAllowed: false,
}));

vi.mock("@/lib/webcodecs/mseSource", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/webcodecs/mseSource")>()),
  MseSource: { attach: async () => mse },
}));

function track(o: Partial<MatroskaTrack> & Pick<MatroskaTrack, "number" | "type" | "codecId">): MatroskaTrack {
  return {
    codecPrivate: null, language: "fra", name: null,
    isDefault: false, isForced: false, isHearingImpaired: false, isEnabled: true, defaultDurationNs: null, ...o,
  };
}

const VIDEO = track({ number: 1, type: "video", codecId: "V_MPEGH/ISO/HEVC" });
const AAC = track({ number: 2, type: "audio", codecId: "A_AAC", codecPrivate: new Uint8Array([0x11, 0x90]), audio: { sampleRate: 48000, channels: 2 } });
const EAC3 = track({ number: 3, type: "audio", codecId: "A_EAC3", language: "eng", audio: { sampleRate: 48000, channels: 6 } });
const AAC_ENG = track({ ...AAC, number: 4, language: "eng" });
const FILE = {
  timestampScaleNs: 1_000_000, durationSeconds: 5400, tracks: [VIDEO, AAC, EAC3, AAC_ENG], cues: [],
  segmentDataStart: 0, segmentEnd: 1000, firstClusterOffset: 0,
} as MatroskaFile;

const PLAN: RemuxPlan = {
  videoMimeType: 'video/mp4; codecs="hvc1.2.4.L150.90"',
  audioMimeType: 'audio/mp4; codecs="mp4a.40.2"',
  videoInit: new Uint8Array([1]),
  audioInit: new Uint8Array([2]),
  durationSeconds: 5400,
};

function video(at: number) {
  return { currentTime: at, addEventListener: () => {}, removeEventListener: () => {} } as unknown as HTMLVideoElement;
}

async function start(at: number, seekable: boolean) {
  const { RemuxPlayback } = await import("@/lib/webcodecs/remuxPlayback");
  const remuxer = {
    seekable,
    plan: () => PLAN,
    setAudioTrack: vi.fn(async () => {}),
    audioTracks: () => [AAC, EAC3, AAC_ENG],
    subtitleTracks: () => [],
    close: vi.fn(),
  };
  const chosen = { path: "remux", remuxer: remuxer as unknown as Remuxer, plan: PLAN, attempts: [] } as ChosenPath;
  const onWarning = vi.fn();
  const source = { size: 1, read: async () => new Uint8Array(0), close: () => {} } as ByteSource;
  const playback = await RemuxPlayback.start(video(at), source, FILE, VIDEO, AAC, chosen, {
    streamUrl: "http://x/film.mkv",
    startSeconds: 0,
    onError: vi.fn(),
    onWarning,
  });
  return { playback, remuxer, onWarning };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Un navigateur qui prend l'AAC et l'E-AC3 tels quels : passer de l'un à l'autre change le
  // format livré, et demande donc une reconstruction sur un fichier indexé.
  vi.stubGlobal("window", { ManagedMediaSource: { isTypeSupported: () => true } });
});
afterEach(() => vi.unstubAllGlobals());

describe("changer de piste sur un fichier sans index", () => {
  it("refuse, en cours de film, comme un saut est refusé — et la piste d'avant continue", async () => {
    const { playback, remuxer, onWarning } = await start(600, false);

    // Pas de reconstruction : elle rouvrirait le film à zéro.
    expect(playback.needsRebuildForAudio(EAC3.number)).toBe(false);
    // Ni de rechargement du son : il relirait le fichier depuis son premier octet.
    await playback.selectAudioTrack(AAC_ENG.number);
    expect(onWarning).toHaveBeenCalledWith({ code: "noIndexAudio" });
    expect(remuxer.setAudioTrack).not.toHaveBeenCalled();
    expect(mse.refillAudio).not.toHaveBeenCalled();
    expect(playback.currentAudioTrack).toBe(AAC.number);
  });

  it("laisse faire au tout début du film, où lire depuis le début est la bonne réponse", async () => {
    const { playback, remuxer, onWarning } = await start(0.5, false);
    expect(playback.needsRebuildForAudio(EAC3.number)).toBe(true);
    await playback.selectAudioTrack(AAC_ENG.number);
    expect(onWarning).not.toHaveBeenCalled();
    expect(remuxer.setAudioTrack).toHaveBeenCalledWith(AAC_ENG.number);
    expect(mse.refillAudio).toHaveBeenCalled();
  });

  it("ne change rien pour un fichier indexé", async () => {
    const { playback, remuxer } = await start(600, true);
    expect(playback.needsRebuildForAudio(EAC3.number)).toBe(true);
    await playback.selectAudioTrack(AAC_ENG.number);
    expect(remuxer.setAudioTrack).toHaveBeenCalledWith(AAC_ENG.number);
  });
});
