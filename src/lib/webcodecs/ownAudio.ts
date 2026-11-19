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
import { openAc3DtsDecoder } from "./truehd/truehdDecoder";
import { noteLumenFacts } from "./lumenFacts";

/** Combien de son par message au worker : un quart de seconde, comme le TrueHD (truehdAudio.ts). */
const BATCH_S = 0.25;

/**
 * NOTRE décodeur AC-3/E-AC3/DTS (FFmpeg 7.1.5, tools/ac3dts-wasm) dans le worker du TrueHD — ou sur
 * le fil principal, un lot à la fois, quand le worker n'a pas pu naître (truehdDecoder.ts).
 *
 * Les paquets partent par lots d'un quart de seconde : un message par trame AC-3 (32 ms), c'était
 * trente allers-retours par seconde de son. Chaque paquet garde son instant : une trame décodée
 * porte celui de son paquet, comme le fait le décodeur de mediabunny.
 */
function ownWasmOpener(name: string) {
  const which = name === "ac3" ? 0 : name === "eac3" ? 1 : 2;
  return async (onFrame: (f: RawFrame) => void, onError: (e: unknown) => void): Promise<PacketDecoder> => {
    const decoder = await openAc3DtsDecoder(which);
    noteLumenFacts({ decoder: `ffmpeg-7.1.5-${name}`, thread: decoder.thread, ...(decoder.workerRefusal !== undefined ? { workerRefusal: decoder.workerRefusal } : {}) });
    let batch: DemuxedAudioPacket[] = [];
    let closed = false;
    const send = async () => {
      if (batch.length === 0 || closed) return;
      const packets = batch;
      batch = [];
      try {
        const out = await decoder.decode(packets.map((p) => p.data));
        if (closed) return;
        let at = 0;
        packets.forEach((packet, i) => {
          const frames = out.frames[i];
          if (frames <= 0) return;
          const planes = Array.from({ length: out.channels }, () => new Float32Array(frames));
          for (let f = 0; f < frames; f++) for (let c = 0; c < out.channels; c++) planes[c][f] = out.pcm[(at + f) * out.channels + c];
          at += frames;
          onFrame({ planes, sampleRate: out.sampleRate, timestamp: packet.timestamp });
        });
      } catch (error) {
        onError(error);
      }
    };
    return {
      decode: async (p: DemuxedAudioPacket) => {
        batch.push(p);
        if (p.timestamp - batch[0].timestamp >= BATCH_S) await send();
      },
      flush: send,
      close: () => {
        if (closed) return;
        closed = true;
        decoder.close();
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
  if (!decoderName.startsWith("ffmpeg-")) noteLumenFacts({ decoder: decoderName });
  return {
    format: { sampleRate, numberOfChannels },
    samples: (fromSeconds: number) => decodedFrom(audioPacketsFrom(source, file, trackNumber, fromSeconds, stats), opener, fromSeconds, sampleRate),
    stats,
    decoder: decoderName,
  };
}
