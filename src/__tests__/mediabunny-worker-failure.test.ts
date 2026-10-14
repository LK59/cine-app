import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { MemoryByteSource, isNetworkFailure, isReadAbandoned } from "@/lib/webcodecs/byteSource";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { SoftwareAudioTrack } from "@/lib/webcodecs/softwareAudio";
import { choosePlaybackPath } from "@/lib/webcodecs/pathSelector";

// Le module de travail (worker) des décodeurs AC-3 et DTS de mediabunny qui ne démarre pas — une
// CSP qui le refuse — ou qui meurt en plein film.
//
// Jusqu'à 1.58.1, son erreur n'était écoutée par personne : la commande en attente ne se résolvait
// jamais. À l'ouverture, l'amorçage de l'encodeur attendait son délai et le film partait au lecteur
// serveur en accusant l'encodeur (« n'a pas répondu ») ; en plein film, la lecture du son attendait
// pour toujours, muette. Depuis 1.61.4 (montée du 14/10/2026), l'erreur du module rejette toutes
// les commandes en attente et les suivantes. Ce qui compte ici est ce que *notre* chaîne en fait :
// une erreur nommée qui remonte jusqu'au refus du chemin natif — donc au lecteur serveur
// (`fallToStable`) —, sans qu'aucun de nos `try/catch` ne l'avale ni ne la prenne pour une coupure
// réseau (qui afficherait « connexion perdue » au lieu de passer la main).
//
// Le module de travail n'est pas cassable à volonté sous Node : on remplace l'extension AC-3 par un
// décodeur qui échoue *comme* celui de 1.61.4 — `init()` ou `decode()` rejetés avec le message de
// mediabunny —, enregistré dans le vrai mediabunny, sur un vrai Matroska démultiplexé par lui.

const WORKER_ERROR = "AC-3 codec worker failed to load or crashed.";
const failure = vi.hoisted(() => ({ at: "init" as "init" | "decode", decoded: 0 }));

vi.mock("@mediabunny/ac3", async () => {
  const mb = await import("mediabunny");
  class FailingAc3Decoder extends mb.CustomAudioDecoder {
    static override supports(codec: string) {
      return codec === "ac3" || codec === "eac3";
    }
    override async init() {
      if (failure.at === "init") throw new Error(WORKER_ERROR);
    }
    override async decode(packet: InstanceType<typeof mb.EncodedPacket>) {
      // Quelques paquets décodés (du silence), puis le module meurt : le cas « en plein film ».
      if (failure.decoded >= 3) throw new Error(WORKER_ERROR);
      failure.decoded += 1;
      this.onSample(
        new mb.AudioSample({
          data: new Float32Array(1536),
          format: "f32-planar",
          numberOfChannels: 1,
          sampleRate: 48000,
          timestamp: packet.timestamp,
        })
      );
    }
    override async flush() {}
    override async close() {}
  }
  let registered = false;
  return {
    registerAc3Decoder: () => {
      if (registered) return;
      registered = true;
      mb.registerDecoder(FailingAc3Decoder);
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
  failure.at = "init";
  failure.decoded = 0;
  // Un navigateur qui ne prend pas l'AC-3 tel quel (Chrome, Firefox) : la piste est décodée ici.
  const source = { isTypeSupported: (mime: string) => !/ac-3|ec-3/.test(mime) };
  vi.stubGlobal("window", { ManagedMediaSource: source });
  vi.stubGlobal("MediaSource", source);
  vi.stubGlobal("AudioData", FakeAudioData);
  vi.stubGlobal("AudioEncoder", FakeAudioEncoder);
});
afterEach(async () => {
  // Le temps que la fermeture rejetée de mediabunny (ci-dessous) arrive pendant ce fichier.
  await new Promise((resolve) => setTimeout(resolve, 20));
  vi.unstubAllGlobals();
});

/**
 * Le rejet que mediabunny laisse filer, attendu et trié plutôt que subi.
 *
 * Une fois `init()` ou `decode()` rejeté, la file d'appels de mediabunny reste rejetée, et la
 * fermeture qu'elle y ajoute (`void …call(() => close())`, media-sink, identique en 1.58.1 et 1.61.4)
 * rejette à son tour sans que personne ne l'écoute. Dans un navigateur, c'est une ligne
 * `scope: "client"` de plus dans server.log (`reportClientError`, rejets non gérés) — une trace,
 * pas une panne. Vitest en ferait un échec de la suite ; il se retire dès qu'un autre écouteur
 * existe. Celui-ci ne laisse passer que ces rejets-là, au message exact : tout autre fait échouer
 * le fichier à la fin.
 */
const unexpected: unknown[] = [];
const filter = (reason: unknown) => {
  if (reason instanceof Error && reason.message === WORKER_ERROR) return;
  unexpected.push(reason);
};
beforeAll(() => {
  process.on("unhandledRejection", filter);
});
afterAll(() => {
  process.off("unhandledRejection", filter);
  expect(unexpected).toEqual([]);
});

async function opened() {
  const source = new MemoryByteSource(new Uint8Array(readFileSync(FIXTURE)));
  const file = await openMediaFile(source);
  const ac3 = file.tracks.find((t) => t.codecId === "A_AC3")!;
  const video = file.tracks.find((t) => t.type === "video")!;
  return { source, file, ac3, video };
}

describe("module de travail AC-3/DTS de mediabunny en échec", () => {
  it("à l'ouverture : le décodé lève l'erreur du module au lieu d'attendre pour toujours", async () => {
    const { source, file, ac3 } = await opened();
    const track = await SoftwareAudioTrack.open(source, ac3.number, ac3.codecId, file);
    const samples = track.samples(0);
    await expect(within(samples.next())).rejects.toThrow(WORKER_ERROR);
    track.close();
  });

  it("en plein film : le décodé s'arrête sur l'erreur nommée, pas sur un silence sans fin", async () => {
    failure.at = "decode";
    const { source, file, ac3 } = await opened();
    const track = await SoftwareAudioTrack.open(source, ac3.number, ac3.codecId, file);
    const read = async () => {
      let blocks = 0;
      for await (const block of track.samples(0)) blocks += block.planes.length > 0 ? 1 : 0;
      return blocks;
    };
    await expect(within(read())).rejects.toThrow(WORKER_ERROR);
    track.close();
  });

  it("atteint le refus du chemin natif — ce qui envoie le film au lecteur serveur — sans passer pour une coupure réseau", async () => {
    const { source, file, ac3, video } = await opened();
    let caught: unknown = null;
    try {
      await within(choosePlaybackPath({ source, file, videoTrack: video, audioTrack: ac3, dimensions: { width: 1920, height: 1080 }, startSeconds: 0 }));
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
