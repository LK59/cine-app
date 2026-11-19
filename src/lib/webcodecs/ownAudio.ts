// Une piste son décodée par nos paquets (audioDemux.ts) et le décodeur de son codec (DECISIONS.md §197).
//
// `samples(fromSeconds)` → plans Float32 et instant, la forme que le transcodeur attend. Les décodeurs :
// - AC-3, E-AC3 et DTS : FFmpeg 7.1.5 compilé ici (tools/ac3dts-wasm), dans le worker du TrueHD ;
// - FLAC : libFLAC (@wasm-audio-decoders/flac) ;
// - PCM : une conversion d'octets ;
// - Opus, AAC et MP3 : l'AudioDecoder du navigateur.
//
// Jusqu'au retrait de mediabunny, ce chemin pouvait aussi nourrir ses décodeurs (les bancs de
// comparaison) : le son y était identique à l'échantillon près sur la bibliothèque.
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
import { openAc3DtsDecoder } from "./truehd/truehdDecoder";
import { noteLumenFacts } from "./lumenFacts";
import { streamInfoHeader } from "./flacHeader";

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

/** Le nom du codec pour ce module, et sa chaîne WebCodecs. */
export function codecNamesFor(codecId: string, codecPrivate: Uint8Array | null): { name: string; webCodecs: string } | null {
  if (codecId === "A_AC3") return { name: "ac3", webCodecs: "ac-3" };
  if (codecId === "A_EAC3") return { name: "eac3", webCodecs: "ec-3" };
  if (codecId === "A_DTS" || codecId.startsWith("A_DTS/")) return { name: "dts", webCodecs: "dtsc" };
  if (codecId === "A_FLAC") return { name: "flac", webCodecs: "flac" };
  if (codecId === "A_OPUS") return { name: "opus", webCodecs: "opus" };
  // MP3 : l'AudioDecoder du navigateur, comme mediabunny (*The Leftovers* VF, 19/11/2026).
  if (codecId === "A_MPEG/L3") return { name: "mp3", webCodecs: "mp3" };
  // PCM : une simple conversion d'octets, ici (`pcmOpener`), comme mediabunny la faisait en JavaScript.
  if (codecId.startsWith("A_PCM/")) return { name: "pcm", webCodecs: "pcm" };
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

/** L'AudioDecoder du navigateur (Opus, AAC), avec le recalage de l'instant de mediabunny pour Chromium. */
function webCodecsOpener(config: AudioDecoderConfig) {
  return async (onFrame: (f: RawFrame) => void, onError: (e: unknown) => void): Promise<PacketDecoder> => {
    let expectedFirst: number | null = null;
    let offset: number | null = null;
    let waiting: (() => void) | null = null;
    const decoder = new AudioDecoder({
      output: (data) => {
        // Une place se libère aussi quand une trame sort : un navigateur sans l'évènement `dequeue`
        // ne laisse pas l'envoi suivant attendre pour toujours.
        waiting?.();
        waiting = null;
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

/**
 * Le FLAC par libFLAC (@wasm-audio-decoders/flac) — ce que faisait le décodeur enregistré auprès de
 * mediabunny jusqu'au 19/11/2026 : STREAMINFO seul en en-tête (`streamInfoHeader`, le PADDING de *Martin Guerre*
 * faisait planter libFLAC), un paquet à la fois, l'instant du paquet sur la trame rendue.
 */
function flacOpener(config: AudioDecoderConfig) {
  return async (onFrame: (f: RawFrame) => void, onError: (e: unknown) => void): Promise<PacketDecoder> => {
    const { FLACDecoder } = await import("@wasm-audio-decoders/flac");
    let decoder: InstanceType<typeof FLACDecoder> | null = new FLACDecoder();
    await decoder.ready;
    const description = config.description;
    if (description) {
      const bytes = ArrayBuffer.isView(description)
        ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
        : new Uint8Array(description as ArrayBuffer);
      await decoder.decodeFrames([streamInfoHeader(bytes)]);
    }
    return {
      decode: async (p: DemuxedAudioPacket) => {
        try {
          if (!decoder) throw new Error("décodeur FLAC non initialisé");
          const decoded = await decoder.decodeFrames([p.data]);
          if (decoded.samplesDecoded === 0) {
            // Une trame vide qui dit pourquoi est une erreur ; vide sans rien dire, libFLAC lit devant.
            if (decoded.errors.length > 0) throw new Error(`FLAC illisible : ${decoded.errors[0].message}`);
            return;
          }
          const frames = decoded.samplesDecoded;
          onFrame({ planes: decoded.channelData.map((plane) => plane.slice(0, frames)), sampleRate: decoded.sampleRate, timestamp: p.timestamp });
        } catch (error) {
          onError(error);
        }
      },
      flush: async () => {},
      close: () => {
        decoder?.free();
        decoder = null;
      },
    };
  };
}

/**
 * Le générateur tel quel, mais dont `return()` lève `cancel` **avant** d'être mis en file : un
 * générateur asynchrone suspendu sur une lecture ne traite son `return()` qu'au prochain `yield`.
 */
function stoppable<T>(inner: AsyncGenerator<T>, cancel: { stopped: boolean }): AsyncGenerator<T> {
  const wrapped = {
    next: (...args: [] | [unknown]) => inner.next(...args),
    return: (value?: unknown) => {
      cancel.stopped = true;
      return inner.return(value as T);
    },
    throw: (error?: unknown) => {
      cancel.stopped = true;
      return inner.throw(error);
    },
    [Symbol.asyncIterator]() {
      return wrapped;
    },
  };
  return wrapped as unknown as AsyncGenerator<T>;
}

/**
 * Le PCM d'un Matroska (`A_PCM/INT/LIT`, `/INT/BIG`, `/FLOAT/IEEE`), converti en plans Float32 —
 * l'arithmétique de mediabunny (`PcmAudioDecoderWrapper` puis `AudioSample.copyTo`) : 8 bits non
 * signés centrés sur 128, entiers signés divisés par 2^(bits−1), flottants tels quels. Un seul
 * épisode de la bibliothèque en porte (19/11/2026).
 */
function pcmOpener(codecId: string, bitDepth: number, channels: number, sampleRate: number) {
  const big = codecId === "A_PCM/INT/BIG";
  const float = codecId === "A_PCM/FLOAT/IEEE";
  const bytes = bitDepth / 8;
  if (![1, 2, 3, 4, 8].includes(bytes) || (float && bytes < 4)) throw new Error(`PCM ${bitDepth} bits hors de ce chemin`);
  const read = (view: DataView, at: number): number => {
    if (float) return bytes === 4 ? view.getFloat32(at, !big) : view.getFloat64(at, !big);
    switch (bytes) {
      case 1:
        return (view.getUint8(at) - 128) / 128;
      case 2:
        return view.getInt16(at, !big) / 32768;
      case 3: {
        const b0 = view.getUint8(at);
        const b1 = view.getUint8(at + 1);
        const b2 = view.getUint8(at + 2);
        const v = big ? (b0 << 16) | (b1 << 8) | b2 : (b2 << 16) | (b1 << 8) | b0;
        return ((v << 8) >> 8) / 8388608;
      }
      default:
        return view.getInt32(at, !big) / 2147483648;
    }
  };
  return async (onFrame: (f: RawFrame) => void): Promise<PacketDecoder> => ({
    decode: async (p: DemuxedAudioPacket) => {
      const frames = Math.floor(p.data.byteLength / (bytes * channels));
      if (frames <= 0) return;
      const view = new DataView(p.data.buffer, p.data.byteOffset, p.data.byteLength);
      const planes = Array.from({ length: channels }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) planes[c][i] = read(view, (i * channels + c) * bytes);
      onFrame({ planes, sampleRate, timestamp: p.timestamp });
    },
    flush: async () => {},
    close: () => {},
  });
}

export interface OwnAudioTrack {
  format: { sampleRate: number; numberOfChannels: number };
  samples(fromSeconds: number): AsyncGenerator<DecodedFrame>;
  /** Le coût du lecteur, cumulé sur toutes les lectures de la piste. */
  stats: AudioDemuxStats;
  /** Qui décode : « ffmpeg-7.1.5-eac3 », « flac », « navigateur »… — pour le journal. */
  decoder: string;
}

/**
 * Ouvre une piste par nos paquets. Lève, avec la raison, quand rien ici ne sait la décoder (un codec
 * qu'aucun module ne nomme, un AAC ou un Opus que le navigateur refuse) : le pipeline passe alors la
 * main au lecteur serveur, ou à l'AAC en WebAssembly (softwareAudio.ts).
 */
export async function openOwnAudioTrack(source: ByteSource, file: MatroskaFile, trackNumber: number): Promise<OwnAudioTrack> {
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
  if (names.name === "ac3" || names.name === "eac3" || names.name === "dts") {
    opener = ownWasmOpener(names.name);
    decoderName = `ffmpeg-7.1.5-${names.name}`;
  } else if (names.name === "pcm") {
    opener = pcmOpener(track.codecId, track.audio?.bitDepth ?? 16, numberOfChannels, sampleRate);
    decoderName = "pcm";
  } else if (names.name === "flac") {
    opener = flacOpener(config);
    decoderName = "flac";
  } else if (names.name === "opus" || names.name === "aac" || names.name === "mp3") {
    // Demandé au navigateur avant d'ouvrir, comme `canDecode` le faisait : un AAC refusé repart alors
    // vers le décodeur AAC en WebAssembly (softwareAudio.ts), au lieu d'échouer en pleine lecture.
    const Decoder = (globalThis as { AudioDecoder?: typeof AudioDecoder }).AudioDecoder;
    const answer = Decoder ? await Decoder.isConfigSupported(config).catch(() => null) : null;
    if (!answer?.supported) throw new Error(`le décodeur logiciel refuse ${names.name}`);
    opener = webCodecsOpener(config);
    decoderName = "navigateur";
  } else {
    throw new Error(`aucun décodeur pour ${names.name}`);
  }
  const stats = newAudioDemuxStats();
  if (!decoderName.startsWith("ffmpeg-")) noteLumenFacts({ decoder: decoderName });
  return {
    format: { sampleRate, numberOfChannels },
    samples: (fromSeconds: number) => {
      // Un saut ailleurs abandonne cette lecture par `return()` : levé tout de suite, pour que la
      // lecture des paquets cesse au tour suivant au lieu de chercher encore (jusqu'à GIVE_UP_S).
      const cancel = { stopped: false };
      return stoppable(decodedFrom(audioPacketsFrom(source, file, trackNumber, fromSeconds, stats, cancel), opener, fromSeconds, sampleRate, cancel), cancel);
    },
    stats,
    decoder: decoderName,
  };
}

/** Pour les tests : les ouvreurs qui ne passent ni par le worker ni par le navigateur. */
export const __testing = { flacOpener, pcmOpener };
