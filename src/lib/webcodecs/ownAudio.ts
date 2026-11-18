// Une piste son décodée par nos paquets (audioDemux.ts) et le décodeur adapté — essai du 19/11/2026.
//
// La même forme que ce que rend `SoftwareAudioTrack` par mediabunny, pour que le transcodeur ne voie
// pas la différence : `samples(fromSeconds)` → plans Float32 et instant. Les décodeurs :
// - AC-3 / E-AC3 et DTS : ceux de @mediabunny/ac3 et /dts (FFmpeg compilé), appelés directement ;
// - FLAC : le nôtre (flacDecoder.ts) ;
// - Opus et AAC : l'AudioDecoder du navigateur, comme mediabunny le fait.
import type { ByteSource } from "./byteSource";
import type { MatroskaFile } from "./matroska";
import {
  audioPacketsFrom,
  decodedFrom,
  newAudioDemuxStats,
  type AudioDemuxStats,
  type DecodedFrame,
  type DemuxedAudioPacket,
  type PacketDecoder,
  type RawFrame,
} from "./audioDemux";
import { decoderClassFor } from "./decoderClasses";
import { closeDecoder, decodeBlocks, type DecodeScratch } from "./truehd/truehdWorker.mjs";
import type { Ac3DtsModule } from "./ac3dts/ac3dts-wasm.mjs";

/** Le module AC-3/E-AC3/DTS de FFmpeg 7.1.5 (tools/ac3dts-wasm), instancié une fois. */
let ac3dts: Promise<Ac3DtsModule> | null = null;
function ac3dtsModule(): Promise<Ac3DtsModule> {
  if (!ac3dts) {
    ac3dts = import("./ac3dts/ac3dts-wasm.mjs").then(({ default: create }) => create());
    ac3dts.catch(() => {
      ac3dts = null;
    });
  }
  return ac3dts;
}

/**
 * NOTRE décodeur AC-3/E-AC3/DTS (FFmpeg 7.1.5 compilé ici, la même colle que le TrueHD) — sur le fil
 * principal pour cet essai ; le worker du TrueHD (truehdWorker.mjs) sait déjà le porter.
 */
function ownWasmOpener(name: string) {
  const which = name === "ac3" ? 0 : name === "eac3" ? 1 : 2;
  return async (onFrame: (f: RawFrame) => void, onError: (e: unknown) => void): Promise<PacketDecoder> => {
    const m = await ac3dtsModule();
    const decoder = m._thd_open(which);
    if (!decoder) throw new Error(`le décodeur ${name} n'a pas pu s'ouvrir`);
    const scratch: DecodeScratch = { input: 0, inputSize: 0 };
    let closed = false;
    return {
      decode: async (p: DemuxedAudioPacket) => {
        if (closed) return;
        try {
          const batch = decodeBlocks(m as never, decoder, scratch, [p.data]);
          const frames = batch.frames[0];
          if (frames <= 0) return;
          const planes = Array.from({ length: batch.channels }, () => new Float32Array(frames));
          for (let i = 0; i < frames; i++) for (let c = 0; c < batch.channels; c++) planes[c][i] = batch.pcm[i * batch.channels + c];
          onFrame({ planes, sampleRate: batch.sampleRate, timestamp: p.timestamp });
        } catch (error) {
          onError(error);
        }
      },
      flush: async () => {},
      close: () => {
        if (closed) return;
        closed = true;
        closeDecoder(m as never, decoder, scratch);
      },
    };
  };
}

type Core = typeof import("mediabunny");

/** Le nom de codec de mediabunny (celui que `supports` attend) et la chaîne WebCodecs. */
export function codecNamesFor(codecId: string, codecPrivate: Uint8Array | null): { name: string; webCodecs: string } | null {
  if (codecId === "A_AC3") return { name: "ac3", webCodecs: "ac-3" };
  if (codecId === "A_EAC3") return { name: "eac3", webCodecs: "ec-3" };
  if (codecId === "A_DTS" || codecId.startsWith("A_DTS/")) return { name: "dts", webCodecs: "dtsc" };
  if (codecId === "A_FLAC") return { name: "flac", webCodecs: "flac" };
  if (codecId === "A_OPUS") return { name: "opus", webCodecs: "opus" };
  if (codecId === "A_AAC" || codecId.startsWith("A_AAC/")) {
    // L'objet AAC est dans les cinq premiers bits de l'AudioSpecificConfig (31 : échappé sur six).
    let aot = 2;
    if (codecPrivate && codecPrivate.length >= 1) {
      aot = codecPrivate[0] >> 3;
      if (aot === 31 && codecPrivate.length >= 2) aot = 32 + (((codecPrivate[0] & 0x07) << 3) | (codecPrivate[1] >> 5));
    }
    return { name: "aac", webCodecs: `mp4a.40.${aot}` };
  }
  return null;
}

function planesOf(sample: { numberOfChannels: number; numberOfFrames: number; copyTo(d: Float32Array, o: { planeIndex: number; format: "f32-planar" }): void }) {
  const planes: Float32Array[] = [];
  for (let channel = 0; channel < sample.numberOfChannels; channel++) {
    const plane = new Float32Array(sample.numberOfFrames);
    sample.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
    planes.push(plane);
  }
  return planes;
}

/** Un décodeur « maison » de mediabunny (classe notée par decoderClasses.ts), nourri de nos paquets. */
function customOpener(core: Core, Decoder: NonNullable<ReturnType<typeof decoderClassFor>>, name: string, config: AudioDecoderConfig) {
  return async (onFrame: (f: RawFrame) => void, onError: (e: unknown) => void): Promise<PacketDecoder> => {
    // @ts-expect-error — classe abstraite pour TypeScript, concrète à l'exécution (c'est l'extension).
    const decoder = new Decoder() as InstanceType<Core["CustomAudioDecoder"]>;
    const writable = decoder as unknown as Record<string, unknown>;
    writable.codec = name;
    writable.config = config;
    writable.onSample = (sample: InstanceType<Core["AudioSample"]>) => {
      onFrame({ planes: planesOf(sample), sampleRate: sample.sampleRate, timestamp: sample.timestamp });
      sample.close();
    };
    writable.onError = onError;
    await decoder.init();
    return {
      decode: async (p: DemuxedAudioPacket) => {
        await decoder.decode(new core.EncodedPacket(p.data, "key", p.timestamp, p.duration));
      },
      flush: async () => {
        await decoder.flush();
      },
      close: () => {
        void Promise.resolve()
          .then(() => decoder.close())
          .catch(() => {});
      },
    };
  };
}

/** L'AudioDecoder du navigateur (Opus, AAC), avec le recalage de l'instant de mediabunny pour Chromium. */
function webCodecsOpener(config: AudioDecoderConfig) {
  return async (onFrame: (f: RawFrame) => void, onError: (e: unknown) => void): Promise<PacketDecoder> => {
    let expectedFirst: number | null = null;
    let offset: number | null = null;
    let waiting: (() => void) | null = null;
    const decoder = new AudioDecoder({
      output: (data) => {
        try {
          const ts = data.timestamp / 1e6;
          // Chromium ne respecte pas un instant de paquet négatif : on recale sur le premier envoyé.
          if (offset === null) offset = expectedFirst !== null ? expectedFirst - ts : 0;
          const planes: Float32Array[] = [];
          for (let c = 0; c < data.numberOfChannels; c++) {
            const plane = new Float32Array(data.numberOfFrames);
            data.copyTo(plane, { planeIndex: c, format: "f32-planar" });
            planes.push(plane);
          }
          onFrame({ planes, sampleRate: data.sampleRate, timestamp: ts + offset });
        } catch (error) {
          onError(error);
        } finally {
          data.close();
        }
      },
      error: (error) => onError(error),
    });
    decoder.addEventListener("dequeue", () => {
      waiting?.();
      waiting = null;
    });
    decoder.configure(config);
    return {
      decode: async (p: DemuxedAudioPacket) => {
        expectedFirst ??= p.timestamp;
        decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: Math.round(p.timestamp * 1e6), duration: Math.round(p.duration * 1e6), data: p.data }));
        // Pas plus de huit paquets en attente : le décodé sort au fil de la lecture, pas d'un bloc.
        while (decoder.decodeQueueSize > 8) await new Promise<void>((resolve) => (waiting = resolve));
      },
      flush: async () => {
        await decoder.flush();
        offset = null;
        expectedFirst = null;
      },
      close: () => {
        if (decoder.state !== "closed") decoder.close();
      },
    };
  };
}

export interface OwnAudioTrack {
  format: { sampleRate: number; numberOfChannels: number };
  samples(fromSeconds: number): AsyncGenerator<DecodedFrame>;
  /** Le coût du lecteur, cumulé sur toutes les lectures de la piste. */
  stats: AudioDemuxStats;
  /** Qui décode : "mediabunny-ac3", "flac", "navigateur"… — pour le journal. */
  decoder: string;
}

/**
 * Ouvre une piste par nos paquets. Lève, avec la raison, quand ce chemin ne sait pas la prendre
 * (codec inconnu, classe de décodeur jamais notée) : l'appelant reprend alors le chemin de mediabunny.
 */
export function openOwnAudioTrack(
  core: Core,
  source: ByteSource,
  file: MatroskaFile,
  trackNumber: number,
  /** "nôtres" : AC-3/E-AC3/DTS par notre module FFmpeg 7.1.5 plutôt que par ceux de mediabunny. */
  decoders: "mediabunny" | "nôtres" = "mediabunny"
): OwnAudioTrack {
  const track = file.tracks.find((t) => t.number === trackNumber && t.type === "audio");
  if (!track) throw new Error(`piste son ${trackNumber} introuvable`);
  const names = codecNamesFor(track.codecId, track.codecPrivate);
  if (!names) throw new Error(`codec ${track.codecId} hors de ce chemin`);
  const sampleRate = track.audio?.sampleRate ?? 48000;
  const numberOfChannels = track.audio?.channels ?? 2;
  const config: AudioDecoderConfig = {
    codec: names.webCodecs,
    sampleRate,
    numberOfChannels,
    ...(track.codecPrivate ? { description: track.codecPrivate } : {}),
  };
  let opener;
  let decoderName: string;
  const Custom = decoderClassFor(names.name, config);
  if (decoders === "nôtres" && (names.name === "ac3" || names.name === "eac3" || names.name === "dts")) {
    opener = ownWasmOpener(names.name);
    decoderName = `ffmpeg-7.1.5-${names.name}`;
  } else if (Custom) {
    opener = customOpener(core, Custom, names.name, config);
    decoderName = names.name === "flac" ? "flac" : `mediabunny-${names.name === "dts" ? "dts" : "ac3"}`;
  } else if (names.name === "opus" || names.name === "aac") {
    opener = webCodecsOpener(config);
    decoderName = "navigateur";
  } else {
    throw new Error(`aucun décodeur noté pour ${names.name}`);
  }
  const stats = newAudioDemuxStats();
  return {
    format: { sampleRate, numberOfChannels },
    samples: (fromSeconds: number) => decodedFrom(audioPacketsFrom(source, file, trackNumber, fromSeconds, stats), opener, fromSeconds, sampleRate),
    stats,
    decoder: decoderName,
  };
}
