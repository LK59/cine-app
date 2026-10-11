// Une piste AAC à PCE, décodée ici par le décodeur AAC de FFmpeg compilé en WebAssembly — la même
// forme de sortie que le décodeur logiciel (SoftwareAudioTrack), pour que la suite ne sache pas
// d'où vient le son (DECISIONS.md §62).
//
// Pourquoi (11/10/2026) : sur l'iPhone de Louis, « Elle s'appelle Ruby » n'avait aucun chemin natif.
// Safari refuse de prendre son AAC à PCE tel quel dans MediaSource (« Le navigateur a refusé une
// opération sur le tampon… »), et son AudioDecoder — CoreAudio — échoue à le décoder
// (« InternalAudioDecoderCocoa decoding failed ») : le film partait au lecteur serveur. Le décodeur
// de FFmpeg, lui, lit le PCE ; son ordre de sortie pour cette forme est celui qui a été mesuré
// (`MEASURED_DECODED_ORDERS`, aacConfig.ts), et la suite est le chemin du TrueHD : ré-encodé.
//
// La lecture des blocs suit celle du TrueHD (truehd/truehdAudio.ts), dont elle reprend le découpage
// dans le temps (`contiguousAudio`) : le même lecteur Matroska, le même cache d'octets. Le module
// TrueHD lui-même n'est pas touché.
import type { ByteSource } from "../byteSource";
import { clusterOffsetForTime, type MatroskaFile, type MatroskaTrack } from "../matroska";
import { createSampleReader, openMediaFile } from "../mediaFile";
import type { DecodedAudio } from "../softwareAudio";
import { contiguousAudio } from "../truehd/truehdAudio";
import { yieldToBrowser } from "../truehd/truehdDecoder";
import { AacCore } from "./aacCore";

/** Un lot par quart de seconde (environ douze trames à 48 kHz), le navigateur reprend la main entre deux. */
const BATCH_US = 250_000;

/**
 * Où commencer à lire avant l'instant demandé. Une trame AAC se décode seule, mais la MDCT recouvre
 * la trame d'avant : la première trame décodée après un saut est fausse. Deux trames suffisent ;
 * un dixième de seconde en laisse quatre, et `contiguousAudio` ne garde que ce qui commence à
 * l'instant voulu.
 */
const PREROLL_US = 100_000;

export interface WasmAacTrack {
  format: { sampleRate: number; numberOfChannels: number };
  samples(fromSeconds: number): AsyncGenerator<DecodedAudio>;
  close(): void;
}

export async function openWasmAacTrack(source: ByteSource, trackNumber: number, parsed?: MatroskaFile): Promise<WasmAacTrack> {
  const file = parsed ?? (await openMediaFile(source));
  const found: MatroskaTrack | undefined = file.tracks.find((t) => t.number === trackNumber && t.type === "audio");
  if (!found || found.codecId !== "A_AAC" || !found.codecPrivate) throw new Error("piste AAC introuvable");
  const track: MatroskaTrack = found;
  const core = await AacCore.create(track.codecPrivate!);
  // L'en-tête dit le compte : c'est celui que le PCE décrit, et celui que le décodeur rend.
  const format = {
    sampleRate: track.audio?.sampleRate ?? 48000,
    numberOfChannels: track.audio?.channels ?? 2,
  };
  let generation = 0;
  let closed = false;

  /** Un seul flux vivant à la fois — même raison que pour le TrueHD (décodeur partagé). */
  async function* samples(fromSeconds: number): AsyncGenerator<DecodedAudio> {
    const mine = ++generation;
    core.reset();
    const fromUs = Math.max(0, fromSeconds) * 1e6;
    const start = clusterOffsetForTime(file, Math.max(0, fromUs - PREROLL_US)) ?? file.firstClusterOffset ?? file.segmentDataStart;
    const reader = createSampleReader(source, file, start);
    let blocks: Uint8Array[] = [];
    let times: number[] = [];
    let dropFirst = true;

    const decodeBatch = async (): Promise<DecodedAudio[] | null> => {
      if (closed || mine !== generation) return null;
      const batch = core.decode(blocks);
      // La toute première trame d'un flux ouvert ou repris ne recouvre rien : son demi-recouvrement
      // est faux. Elle est oubliée — le préroulement a déjà lu de quoi la remplacer.
      if (dropFirst) {
        dropFirst = false;
        const firstIndex = batch.frames.findIndex((n) => n > 0);
        if (firstIndex >= 0) {
          const skip = batch.frames[firstIndex] * batch.channels;
          batch.frames[firstIndex] = 0;
          batch.pcm = batch.pcm.subarray(skip);
        }
      }
      const pieces = contiguousAudio(times, batch, fromSeconds, format.numberOfChannels);
      blocks = [];
      times = [];
      await yieldToBrowser();
      return pieces;
    };

    for (;;) {
      if (closed || mine !== generation) return;
      const sample = await reader.next();
      if (!sample) break;
      if (sample.trackNumber !== track.number) continue;
      if (sample.timestampUs < fromUs - PREROLL_US) continue;
      blocks.push(sample.data);
      times.push(sample.timestampUs);
      if (times[times.length - 1] - times[0] < BATCH_US) continue;
      const pieces = await decodeBatch();
      if (!pieces || closed || mine !== generation) return;
      for (const piece of pieces) yield piece;
    }
    if (blocks.length > 0 && !closed && mine === generation) {
      for (const piece of (await decodeBatch()) ?? []) yield piece;
    }
  }

  return {
    format,
    samples,
    close() {
      closed = true;
      core.close();
    },
  };
}
