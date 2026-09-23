import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ByteSource } from "@/lib/webcodecs/byteSource";
import type { MatroskaFile, MatroskaTrack } from "@/lib/webcodecs/matroska";
import type { ChosenPath } from "@/lib/webcodecs/pathSelector";
import type { Remuxer, RemuxPlan } from "@/lib/webcodecs/remuxer";

// Un changement de piste reconstruit toujours le lecteur, à la position courante *par l'index* —
// sauf sur un fichier sans index en cours de film, où la reconstruction reprendrait le film à zéro.

const mse = vi.hoisted(() => ({
  seek: vi.fn(async () => {}),
  destroy: vi.fn(),
  presentationDelay: 0,
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
/** Un codec que rien ici ne sait porter, ni tel quel ni réencodé. */
const COOK = track({ number: 5, type: "audio", codecId: "A_REAL/COOK", language: "ita", audio: { sampleRate: 44100, channels: 2 } });
const FILE = {
  timestampScaleNs: 1_000_000, durationSeconds: 5400, tracks: [VIDEO, AAC, EAC3, AAC_ENG, COOK], cues: [],
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
    audioTracks: () => [AAC, EAC3, AAC_ENG, COOK],
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
  // Un navigateur qui prend l'AAC et l'E-AC3 tels quels.
  vi.stubGlobal("window", { ManagedMediaSource: { isTypeSupported: () => true } });
});
afterEach(() => vi.unstubAllGlobals());

describe("changer de piste sur un fichier sans index", () => {
  it("refuse, en cours de film, comme un saut est refusé — et la piste d'avant continue", async () => {
    const { playback, onWarning } = await start(600, false);

    // Pas de reconstruction : elle rouvrirait le film à zéro.
    expect(playback.requestAudioTrack(AAC_ENG.number)).toBe("refused");
    expect(onWarning).toHaveBeenCalledWith({ code: "noIndexAudio" });
    expect(playback.currentAudioTrack).toBe(AAC.number);
    expect(mse.seek).not.toHaveBeenCalled();
  });

  it("laisse faire au tout début du film, où repartir du début est la bonne réponse", async () => {
    // La reconstruction rouvre au début : c'est justement là qu'on est.
    const { playback, onWarning } = await start(0.5, false);
    expect(playback.requestAudioTrack(EAC3.number)).toBe("rebuild");
    expect(playback.requestAudioTrack(AAC_ENG.number)).toBe("rebuild");
    expect(onWarning).not.toHaveBeenCalled();
  });
});

/**
 * Tout changement de piste reconstruit le lecteur (22/09/2026), même entre deux pistes du même
 * format : le changement dans le tampon, retiré, laissait sur WebKit le son décalé de l'image
 * jusqu'au saut suivant, et attendait ailleurs jusqu'à plusieurs secondes avant de commencer.
 */
describe("un seul chemin pour changer de piste : la reconstruction", () => {
  it("reconstruit entre deux pistes du même format comme entre deux formats", async () => {
    const { playback, onWarning } = await start(600, true);
    expect(playback.requestAudioTrack(AAC_ENG.number)).toBe("rebuild");
    expect(playback.requestAudioTrack(EAC3.number)).toBe("rebuild");
    expect(onWarning).not.toHaveBeenCalled();
    // Rien n'est touché ici : c'est l'appelant qui reconstruit.
    expect(playback.currentAudioTrack).toBe(AAC.number);
  });

  it("ne demande rien pour la piste qui joue déjà, ni pour une piste inconnue", async () => {
    const { playback } = await start(600, true);
    expect(playback.requestAudioTrack(AAC.number)).toBeNull();
    expect(playback.requestAudioTrack(99)).toBeNull();
  });
});

/**
 * Une piste que ce chemin ne porte pas est refusée tout de suite.
 *
 * Elle était acceptée comme une autre : le lecteur se reconstruisait dessus, échouait, se
 * reconstruisait sur la piste d'avant — une seconde d'écran noir pour revenir au même point, et
 * rien ne disait pourquoi (relevé le 23/09/2026).
 */
describe("une piste qu'aucun chemin ne porte", () => {
  it("est refusée sans reconstruction", async () => {
    const { playback } = await start(600, true);
    expect(playback.requestAudioTrack(COOK.number)).toBe("refused");
    expect(playback.currentAudioTrack).toBe(AAC.number);
  });
});
