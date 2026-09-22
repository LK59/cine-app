// Un fichier, quel que soit son conteneur : la seule porte d'entrée du lecteur.
//
// Tout le lecteur parle Matroska — `MatroskaFile`, `MatroskaTrack`, les identifiants de codec
// `V_MPEGH/ISO/HEVC`, `A_EAC3`… —, et c'est voulu : un MP4 est décrit dans cette même forme
// (mp4Demux.ts), si bien que le choix du chemin, les pistes, le transcodage, les sous-titres et
// les sauts ne font qu'une chose, pour les deux. Ce qui diffère tient ici : qui lit l'en-tête, et
// qui sort les échantillons.
//
// Chaque appelant passe par ces deux fonctions plutôt que par `parseMatroska` et `SampleReader` :
// un seul endroit décide du conteneur, et aucun ne peut l'oublier — c'est ainsi que le MP4 avait
// fini lu par un chemin à part, qui ne savait rien des pistes ni des sous-titres.

import type { ByteSource } from "./byteSource";
import { parseMatroska, type MatroskaFile, type MediaSample } from "./matroska";
import { isIsoBaseMedia, Mp4SampleReader, parseMp4 } from "./mp4Demux";
import { SampleReader } from "./sampleReader";

/** Ce que tout lecteur d'échantillons offre, quel que soit le conteneur. */
export interface MediaSampleReader {
  next(): Promise<MediaSample | null>;
  /** Repart d'une position donnée par l'index (`clusterOffsetForTime`) ou du début du fichier. */
  seekTo(offset: number): void;
  readonly exhausted: boolean;
}

/**
 * Lit l'en-tête d'un fichier, Matroska ou MP4 — reconnu à ses octets, jamais à son nom.
 *
 * @param key nomme le fichier pour que le rouvrir ne relise rien (voir `parseMatroska`).
 */
export async function openMediaFile(source: ByteSource, key?: string): Promise<MatroskaFile> {
  const head = await source.read(0, 12);
  return isIsoBaseMedia(head) ? parseMp4(source, key) : parseMatroska(source, key);
}

/** Le lecteur d'échantillons qui va avec ce fichier, parti de `startOffset`. */
export function createSampleReader(source: ByteSource, file: MatroskaFile, startOffset: number): MediaSampleReader {
  return file.mp4 ? new Mp4SampleReader(source, file, startOffset) : new SampleReader(source, file, startOffset);
}
