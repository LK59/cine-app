import { CHUNK_SIZE, type ByteSource } from "@/lib/webcodecs/byteSource";
import { clusterOffsetForTime } from "@/lib/webcodecs/matroska";
import { createSampleReader, openMediaFile } from "@/lib/webcodecs/mediaFile";

/**
 * Enregistrer ce que le lecteur lit en s'ouvrant à une position — plutôt que de le recalculer.
 *
 * S'ouvrir, pour le lecteur, c'est : l'en-tête et l'index (`openMediaFile`), puis, depuis l'image
 * clé qui précède la position (`clusterOffsetForTime` sur la piste vidéo), les blocs jusqu'un peu
 * après — son compris, puisque les blocs Matroska mêlent les pistes. Ce module fait exactement ces
 * lectures-là, par les mêmes fonctions, sur une source qui note chaque morceau de 1 Mio touché. Les
 * cas particuliers déjà traités par la lecture de l'en-tête (un `hvcC` vide complété depuis la
 * première image clé, un MP4) le sont donc ici aussi, sans rien dupliquer.
 *
 * Ce qui n'est pas couvert (un index qui ment et fait reculer le remultiplexeur plus loin, une piste
 * audio décrite depuis ailleurs) sera simplement lu du réseau : l'ouverture est alors « mixte », et
 * le journal le dit.
 */

/**
 * Jusqu'où lire après la position visée : de quoi produire les premiers segments depuis l'appareil
 * pendant que le réseau prend le relais. Pas davantage : à 8 s, un 4K à 25 Mb/s (*Materialists*,
 * banc du 25/09/2026) dépassait la borne par titre et ne gardait plus que son en-tête. La position
 * visée est celle du recul de reprise ; une ouverture sans recul (titre rejoué il y a moins de dix
 * minutes) tombe 5 s plus loin et lit alors la fin de son premier groupe au réseau — « mixte ».
 */
export const RECORD_AHEAD_SECONDS = 3;
/** Au-delà, un titre ne garde que son en-tête et son index. */
export const MAX_TITLE_CHUNKS = 24;
/** Garde-fou de boucle : un fichier sans image vidéo ne lit pas tout le film. */
const MAX_SAMPLES = 20_000;

/** Une source qui note les morceaux qu'on lui demande. */
export class RecordingSource implements ByteSource {
  readonly touched = new Set<number>();
  constructor(private readonly inner: ByteSource) {}
  get size(): number {
    return this.inner.size;
  }
  read(offset: number, length: number): Promise<Uint8Array> {
    const start = Math.max(0, Math.min(offset, this.size));
    const end = Math.max(start, Math.min(offset + length, this.size));
    if (end > start) {
      for (let index = Math.floor(start / CHUNK_SIZE); index <= Math.floor((end - 1) / CHUNK_SIZE); index++) this.touched.add(index);
    }
    return this.inner.read(offset, length);
  }
  close(): void {
    /* la source enregistrée appartient à l'appelant */
  }
}

export interface RecordedOpening {
  /** Les morceaux à garder, et ce qu'ils couvrent. */
  chunks: number[];
  coveredFrom: number;
  coveredTo: number;
  /** Seuls l'en-tête et l'index : le passage dépassait `MAX_TITLE_CHUNKS`. */
  partial: boolean;
}

/**
 * Lit ce que l'ouverture à `startSeconds` lirait, et rend les morceaux touchés.
 *
 * @param shouldStop interrogé entre deux échantillons — un film qui démarre arrête tout.
 */
export async function recordOpening(source: ByteSource, startSeconds: number, shouldStop: () => boolean = () => false): Promise<RecordedOpening | null> {
  const recorder = new RecordingSource(source);
  // Sans clé : l'en-tête doit être *lu*, pas repris du cache en mémoire, pour que ses octets soient notés.
  const file = await openMediaFile(recorder);
  const headerChunks = [...recorder.touched];
  const video = file.tracks.find((track) => track.type === "video");
  if (!video || shouldStop()) return null;

  const targetUs = Math.max(0, startSeconds) * 1e6;
  const offset = clusterOffsetForTime(file, targetUs, video.number) ?? file.firstClusterOffset ?? file.segmentDataStart;
  const reader = createSampleReader(recorder, file, offset);
  let coveredFrom = Number.POSITIVE_INFINITY;
  let coveredTo = 0;
  let partial = false;
  for (let n = 0; n < MAX_SAMPLES; n++) {
    if (shouldStop()) return null;
    const sample = await reader.next();
    if (!sample) break;
    if (sample.trackNumber === video.number) {
      const at = sample.timestampUs / 1e6;
      coveredFrom = Math.min(coveredFrom, at);
      coveredTo = Math.max(coveredTo, at);
      if (at >= startSeconds + RECORD_AHEAD_SECONDS) break;
    }
    if (recorder.touched.size > MAX_TITLE_CHUNKS) {
      partial = true;
      break;
    }
  }
  if (partial) {
    return { chunks: headerChunks.sort((a, b) => a - b), coveredFrom: 0, coveredTo: 0, partial: true };
  }
  return {
    chunks: [...recorder.touched].sort((a, b) => a - b),
    coveredFrom: Number.isFinite(coveredFrom) ? coveredFrom : startSeconds,
    coveredTo,
    partial: false,
  };
}
