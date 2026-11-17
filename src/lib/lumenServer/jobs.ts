// Le travail d'un fil de calcul de Lumen serveur : construire un index, ou un segment.
//
// Une fonction, appelée telle quelle par le fil principal (`inlineExecutor`, les tests) ou par un
// `worker_threads` (`worker.ts`) : les deux chemins font exactement la même chose. Le fil de calcul
// ouvre le fichier lui-même, par son chemin — rien de lourd ne traverse la frontière entre fils : une
// demande est un chemin et la part de l'index qui la concerne, une réponse des octets transférés.
//
// L'en-tête du fichier est gardé par `openMediaFile` sous la clé d'identité (quatre fichiers par fil,
// `rememberedHeaders`) : la rafale d'une séance ne relit l'en-tête qu'une fois par fil.

import { openMediaFile } from "../webcodecs/mediaFile";
import { FileByteSource } from "./fileSource";
import { identityKey, LumenError, type LumenCutMode, type LumenIndex } from "./format";
import { buildLumenIndex } from "./lumenIndex";
import { buildSegment, type SegmentResult, type SegmentSpec } from "./segment";
import { readAudioFeed, type AudioFeed, type AudioFeedSpec } from "./audio/feed";
import { enhanceWindows, type DialogueWork } from "./audio/dialogue";

export type LumenJob =
  | { type: "index"; path: string; targetUs?: number; cut?: LumenCutMode }
  | { type: "segment"; spec: SegmentSpec }
  | { type: "audio-feed"; spec: AudioFeedSpec }
  /** « Améliorer les dialogues » (§193) : `DialogueEnhancer` sur chaque segment d'une tâche — du calcul, aucun fichier. */
  | { type: "dialogue"; work: DialogueWork };

export interface ReadCost {
  reads: number;
  bytes: number;
  /** Temps passé à attendre le disque. */
  diskMs: number;
  /** Temps total du travail, disque compris. */
  ms: number;
}

export type LumenJobResult =
  | { type: "index"; index: LumenIndex; cost: ReadCost }
  | { type: "segment"; result: SegmentResult; cost: ReadCost }
  /** Le flux élémentaire d'une fenêtre de son à convertir (`audio/feed.ts`), ou null : la fenêtre est dans le silence. */
  | { type: "audio-feed"; feed: AudioFeed | null; cost: ReadCost }
  /** Les fenêtres d'encodeur de chaque segment, traitées (f32 entrelacé, une par segment, dans l'ordre). */
  | { type: "dialogue"; segments: Float32Array[]; cost: ReadCost };

/** Un index lit par petits morceaux (en-têtes de grappe en grappe) ; un segment lit tout, dans l'ordre. */
const INDEX_SOURCE = { chunkSize: 16 * 1024, chunks: 64 };
const SEGMENT_SOURCE = { chunkSize: 256 * 1024, chunks: 16 };
/**
 * Un segment audio ne lit que l'en-tête des blocs vidéo qu'il enjambe : par morceaux de 256 Kio, il
 * relisait toute la plage (51 Mo pour 4,8 Mo de son sur le plus long segment de *Ted Lasso*, banc du
 * 16/11/2026) ; par 4 Kio, l'en-tête et ses voisins.
 */
const AUDIO_SEGMENT_SOURCE = { chunkSize: 4 * 1024, chunks: 64 };

export async function runLumenJob(job: LumenJob): Promise<LumenJobResult> {
  const began = performance.now();
  if (job.type === "dialogue") {
    const segments = enhanceWindows(job.work);
    return { type: "dialogue", segments, cost: { reads: 0, bytes: 0, diskMs: 0, ms: Math.round(performance.now() - began) } };
  }
  if (job.type === "index") {
    const source = await FileByteSource.open(job.path, INDEX_SOURCE);
    try {
      const index = await buildLumenIndex(source, source.identity, { targetUs: job.targetUs, cut: job.cut });
      return { type: "index", index, cost: costOf(source, began) };
    } finally {
      source.close();
    }
  }
  if (job.type === "audio-feed") {
    // Les blocs d'une piste à convertir (phase 2, §161) : comme un segment son copié, les en-têtes de tout ce qui
    // passe et la charge de la seule piste voulue.
    const { spec } = job;
    const source = await FileByteSource.open(spec.path, AUDIO_SEGMENT_SOURCE);
    try {
      if (identityKey(source.identity) !== spec.key) throw new LumenError("fichier-change", "Le fichier a changé depuis son index.");
      const file = await openMediaFile(source, spec.key);
      const feed = await readAudioFeed(source, file, spec);
      return { type: "audio-feed", feed, cost: costOf(source, began) };
    } finally {
      source.close();
    }
  }
  const { spec } = job;
  const source = await FileByteSource.open(spec.path, spec.audio ? AUDIO_SEGMENT_SOURCE : SEGMENT_SOURCE);
  try {
    // Le fichier ouvert est-il celui que l'index décrit ? Sinon, une erreur nette plutôt que les
    // octets d'un autre fichier recollés sur l'init de l'ancien (2-serveur.md §2.1).
    if (identityKey(source.identity) !== spec.key) throw new LumenError("fichier-change", "Le fichier a changé depuis son index.");
    const file = await openMediaFile(source, spec.key);
    const result = await buildSegment(source, file, spec);
    return { type: "segment", result, cost: costOf(source, began) };
  } finally {
    source.close();
  }
}

/** Le tampon entier d'une vue qui l'occupe seule (transférable sans rien emporter d'autre), sinon null. */
export function ownBuffer(view: ArrayBufferView): ArrayBuffer | null {
  const buffer = view.buffer;
  return buffer instanceof ArrayBuffer && view.byteOffset === 0 && view.byteLength === buffer.byteLength ? buffer : null;
}

/**
 * Les tampons d'une demande, transférés plutôt que copiés : le PCM d'une tâche « dialogues » (§193), des dizaines de
 * Mo décodés par ffmpeg, n'a plus d'usage sur le fil principal une fois donné.
 */
export function requestTransferablesOf(job: LumenJob): ArrayBuffer[] {
  if (job.type !== "dialogue") return [];
  const buffer = ownBuffer(job.work.pcm);
  return buffer ? [buffer] : [];
}

function costOf(source: FileByteSource, began: number): ReadCost {
  return { reads: source.stats.reads, bytes: source.stats.bytes, diskMs: Math.round(source.stats.ms), ms: Math.round(performance.now() - began) };
}
