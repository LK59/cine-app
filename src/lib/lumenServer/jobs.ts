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

export type LumenJob = { type: "index"; path: string; targetUs?: number; cut?: LumenCutMode } | { type: "segment"; spec: SegmentSpec };

export interface ReadCost {
  reads: number;
  bytes: number;
  /** Temps passé à attendre le disque. */
  diskMs: number;
  /** Temps total du travail, disque compris. */
  ms: number;
}

export type LumenJobResult = { type: "index"; index: LumenIndex; cost: ReadCost } | { type: "segment"; result: SegmentResult; cost: ReadCost };

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
  if (job.type === "index") {
    const source = await FileByteSource.open(job.path, INDEX_SOURCE);
    try {
      const index = await buildLumenIndex(source, source.identity, { targetUs: job.targetUs, cut: job.cut });
      return { type: "index", index, cost: costOf(source, began) };
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

function costOf(source: FileByteSource, began: number): ReadCost {
  return { reads: source.stats.reads, bytes: source.stats.bytes, diskMs: Math.round(source.stats.ms), ms: Math.round(performance.now() - began) };
}
