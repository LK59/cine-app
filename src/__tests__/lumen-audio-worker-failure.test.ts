import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { MemoryByteSource, isNetworkFailure, isReadAbandoned } from "@/lib/webcodecs/byteSource";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { SoftwareAudioTrack } from "@/lib/webcodecs/softwareAudio";
import { choosePlaybackPath } from "@/lib/webcodecs/pathSelector";

// Le pendant de mediabunny-worker-failure.test.ts pour la chaîne « lumen » (essai demux-son,
// 19/11/2026) : nos décodeurs AC-3/E-AC3/DTS (FFmpeg 7.1.5) dans le worker du TrueHD, qui meurt à
// l'ouverture ou en plein film. La promesse est la même : une erreur nommée qui remonte jusqu'au refus
// du chemin natif — donc au lecteur serveur (`fallToStable`) —, jamais un silence sans fin, jamais
// prise pour une coupure réseau (« connexion perdue » au lieu de passer la main).
//
// Le worker n'est pas cassable à volonté sous Node : `openAc3DtsDecoder` est remplacé par un décodeur
// qui échoue avec le message exact du vrai (`worker AC-3/DTS perdu (…)`, truehdDecoder.ts), sur un vrai
// Matroska lu par notre lecteur.

const WORKER_ERROR = "worker AC-3/DTS perdu (le worker n'a pas démarré)";
const failure = vi.hoisted(() => ({ at: "open" as "open" | "decode", decoded: 0 }));

vi.mock("@/lib/webcodecs/truehd/truehdDecoder", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/webcodecs/truehd/truehdDecoder")>();
  return {
    ...real,
    openAc3DtsDecoder: async () => {
      if (failure.at === "open") throw new Error(WORKER_ERROR);
      return {
        thread: "worker" as const,
        async decode(blocks: Uint8Array[]) {
          // Quelques lots décodés (du silence), puis le worker meurt : le cas « en plein film ».
          if (failure.decoded >= 3) throw new Error(WORKER_ERROR);
          failure.decoded += 1;
          const frames = new Int32Array(blocks.length).fill(1536);
          return { pcm: new Float32Array(1536 * blocks.length), frames, channels: 1, sampleRate: 48000, errors: 0 };
        },
        reset() {},
        close() {},
      };
    },
  };
});

const FIXTURE = "src/__tests__/fixtures/mp4/c-hevc-multi.mkv";

/** Rejette si la promesse n'aboutit pas : un son muet sans fin est précisément l'échec visé. */
function within<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`toujours en attente après ${ms} ms`)), ms))]);
}

class FakeAudioData {
  constructor(readonly init: { numberOfFrames: number; timestamp: number }) {}
  close() {}
}

/** Un encodeur AAC qui accepte tout et se décrit à la première trame. */
class FakeAudioEncoder {
  static async isConfigSupported(config: unknown) {
    return { supported: true, config };
  }
  state = "unconfigured";
  encodeQueueSize = 0;
  constructor(private readonly init: { output: (c: unknown, m?: unknown) => void; error: (e: unknown) => void }) {}
  configure() {
    this.state = "configured";
  }
  encode(data: FakeAudioData) {
    this.init.output(
      { type: "key", timestamp: data.init.timestamp, duration: 21333, byteLength: 4, copyTo: (d: Uint8Array) => d.fill(1) },
      { decoderConfig: { description: new Uint8Array([0x11, 0x88]) } }
    );
  }
  async flush() {}
  reset() {}
  close() {}
}

beforeEach(() => {
  failure.at = "open";
  failure.decoded = 0;
  // Un navigateur qui ne prend pas l'AC-3 tel quel (Chrome, Firefox) : la piste est décodée ici.
  const source = { isTypeSupported: (mime: string) => !/ac-3|ec-3/.test(mime) };
  vi.stubGlobal("window", { ManagedMediaSource: source });
  vi.stubGlobal("MediaSource", source);
  vi.stubGlobal("AudioData", FakeAudioData);
  vi.stubGlobal("AudioEncoder", FakeAudioEncoder);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function opened() {
  const source = new MemoryByteSource(new Uint8Array(readFileSync(FIXTURE)));
  const file = await openMediaFile(source);
  const ac3 = file.tracks.find((t) => t.codecId === "A_AC3")!;
  const video = file.tracks.find((t) => t.type === "video")!;
  return { source, file, ac3, video };
}

const LUMEN = { demux: "nôtre", decoders: "nôtres" } as const;

describe("chaîne « lumen » : notre worker AC-3/DTS en échec", () => {
  it("à l'ouverture : le décodé lève l'erreur du worker au lieu d'attendre pour toujours", async () => {
    const { source, file, ac3 } = await opened();
    const track = await SoftwareAudioTrack.open(source, ac3.number, ac3.codecId, file, LUMEN);
    await expect(within(track.samples(0).next())).rejects.toThrow(WORKER_ERROR);
    track.close();
  });

  it("en plein film : le décodé s'arrête sur l'erreur nommée, pas sur un silence sans fin", async () => {
    failure.at = "decode";
    const { source, file, ac3 } = await opened();
    const track = await SoftwareAudioTrack.open(source, ac3.number, ac3.codecId, file, LUMEN);
    const read = async () => {
      let blocks = 0;
      for await (const block of track.samples(0)) blocks += block.planes.length > 0 ? 1 : 0;
      return blocks;
    };
    await expect(within(read())).rejects.toThrow(WORKER_ERROR);
    expect(failure.decoded).toBe(3);
    track.close();
  });

  it("atteint le refus du chemin natif — ce qui envoie le film au lecteur serveur — sans passer pour une coupure réseau", async () => {
    const { source, file, ac3, video } = await opened();
    let caught: unknown = null;
    try {
      await within(
        choosePlaybackPath({ source, file, videoTrack: video, audioTrack: ac3, dimensions: { width: 1920, height: 1080 }, startSeconds: 0, remux: { audioChain: "lumen" } })
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    // Le libellé exact que l'hôte reçoit et passe à `fallToStable`, et que la page Activité groupe.
    expect((caught as Error).message).toBe(`Aucun chemin de lecture disponible pour ce fichier. remux : ${WORKER_ERROR}`);
    expect(isNetworkFailure(caught)).toBe(false);
    expect(isReadAbandoned(caught)).toBe(false);
  });
});
