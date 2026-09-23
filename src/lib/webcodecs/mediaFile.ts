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
import { hevcParameterSets, hevcRecordHasParameterSets, hevcRecordWithParameterSets, nalLengthSize } from "./codecConfig";
import { trace } from "./trace";

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
  const known = key === undefined ? undefined : containers.get(key);
  const mp4 = known !== undefined ? known === "mp4" : isIsoBaseMedia(await source.read(0, 12));
  if (key !== undefined) {
    containers.delete(key);
    containers.set(key, mp4 ? "mp4" : "matroska");
    while (containers.size > REMEMBERED_CONTAINERS) containers.delete(containers.keys().next().value!);
  }
  const file = mp4 ? await parseMp4(source, key) : await parseMatroska(source, key);
  await completeParameterSets(source, file);
  return file;
}

/** Combien d'échantillons lire au plus pour trouver la première image clé vidéo. */
const PARAMETER_SET_SEARCH = 400;

/**
 * Remplit un `hvcC` vide avec les jeux de paramètres de la première image clé.
 *
 * Voir `hevcRecordHasParameterSets` : un fichier peut ne porter ses VPS/SPS/PPS que dans le flux,
 * et Safari ne démarre alors jamais — sans erreur, sans image. Fait ici, une fois, pour que tout
 * ce qui lit la piste — le remultiplexeur, le canevas, la chaîne de codec — voie le même en-tête.
 * Écrit dans la description de la piste, qui est gardée en mémoire avec l'en-tête du fichier : une
 * réouverture ne relit rien. Rien ne change pour un fichier dont l'en-tête est complet, c'est-à-dire
 * presque tous : la vérification ne lit pas un octet de plus.
 */
async function completeParameterSets(source: ByteSource, file: MatroskaFile): Promise<void> {
  for (const track of file.tracks) {
    if (track.type !== "video" || track.codecId !== "V_MPEGH/ISO/HEVC" || !track.codecPrivate) continue;
    if (track.codecPrivate.length < 23 || hevcRecordHasParameterSets(track.codecPrivate)) continue;
    try {
      const lengthSize = nalLengthSize(track.codecId, track.codecPrivate);
      const reader = createSampleReader(source, file, file.firstClusterOffset ?? file.segmentDataStart);
      for (let n = 0; n < PARAMETER_SET_SEARCH; n++) {
        const sample = await reader.next();
        if (!sample) break;
        if (sample.trackNumber !== track.number) continue;
        const units = hevcParameterSets(sample.data, lengthSize);
        if (!units) continue;
        track.codecPrivate = hevcRecordWithParameterSets(track.codecPrivate, units);
        trace(`en-tête HEVC sans jeux de paramètres : complété depuis la première image clé (${units.length} unités)`);
        break;
      }
    } catch {
      // Laissé tel quel : le fichier se comportera comme avant, et non pire.
    }
  }
}

/**
 * Le conteneur de chaque fichier déjà ouvert, retenu comme son en-tête l'est.
 *
 * Reconnaître un MP4 lit les douze premiers octets du fichier — ce qu'on fait depuis que le MP4
 * passe par le même traitement que le Matroska. Après un saut loin dans le film, ces octets ne
 * sont plus dans le cache : un changement de piste, qui rouvre le fichier, repayait alors un
 * aller-retour réseau pour une réponse déjà connue — 0,4 à 0,7 s sur un réseau lent, alors que
 * l'en-tête, lui, était en mémoire (22/09/2026, les trois changements lents de la journée).
 */
const containers = new Map<string, "mp4" | "matroska">();
const REMEMBERED_CONTAINERS = 16;

/** Le lecteur d'échantillons qui va avec ce fichier, parti de `startOffset`. */
export function createSampleReader(source: ByteSource, file: MatroskaFile, startOffset: number): MediaSampleReader {
  return file.mp4 ? new Mp4SampleReader(source, file, startOffset) : new SampleReader(source, file, startOffset);
}
