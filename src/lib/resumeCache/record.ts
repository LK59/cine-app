import { CHUNK_SIZE, type ByteSource } from "@/lib/webcodecs/byteSource";
import { clusterOffsetForTime } from "@/lib/webcodecs/matroska";
import { createSampleReader, openMediaFile } from "@/lib/webcodecs/mediaFile";
import { OPENING_TITLE_CHUNKS } from "./budget";
import { MIN_COVERED_AHEAD_SECONDS } from "./plan";

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
 * Jusqu'où lire après la position visée : un nombre de morceaux, plus une durée (28/09/2026).
 *
 * C'était 3 s, puis l'en-tête seul au-delà de 24 Mio par titre : à 8 s, un 4K à 25 Mb/s
 * (*Materialists*, banc du 25/09/2026) dépassait déjà la borne. Une durée fixe gardait 3 s d'un
 * film léger comme d'un 4K. En morceaux (`budget.ts`), c'est le fichier qui dit combien de temps
 * ils couvrent : 16 Mio font 20 s au débit médian de la bibliothèque, 128 Mio deux minutes et
 * demie. Le passage doit couvrir au moins `MIN_COVERED_AHEAD_SECONDS` après la position, sinon
 * seuls l'en-tête et l'index sont gardés — un groupe d'images plus long que le budget.
 */
/** Garde-fou de boucle : un fichier sans image vidéo ne lit pas tout le film. */
const MAX_SAMPLES = 100_000;

/** Une source qui note les morceaux qu'on lui demande. */
export class RecordingSource implements ByteSource {
  readonly touched = new Set<number>();
  /** @param onTouch appelé une fois par morceau, au premier octet demandé — pour l'écrire au fil de l'eau. */
  constructor(
    private readonly inner: ByteSource,
    private readonly onTouch?: (index: number) => void
  ) {}
  get size(): number {
    return this.inner.size;
  }
  read(offset: number, length: number): Promise<Uint8Array> {
    const start = Math.max(0, Math.min(offset, this.size));
    const end = Math.max(start, Math.min(offset + length, this.size));
    if (end > start) {
      for (let index = Math.floor(start / CHUNK_SIZE); index <= Math.floor((end - 1) / CHUNK_SIZE); index++) {
        if (this.touched.has(index)) continue;
        this.touched.add(index);
        this.onTouch?.(index);
      }
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
  /** Seuls l'en-tête et l'index : le budget ne couvrait pas la position et ce qui la suit. */
  partial: boolean;
}

/**
 * Lit ce que l'ouverture à `startSeconds` lirait, et rend les morceaux touchés.
 *
 * @param shouldStop interrogé entre deux échantillons — un film qui démarre arrête tout.
 * @param budgetChunks les morceaux du passage, au-delà de l'en-tête et de l'index.
 * @param onChunk chaque morceau touché, au moment où il l'est — voir `RecordingSource`.
 */
export async function recordOpening(
  source: ByteSource,
  startSeconds: number,
  shouldStop: () => boolean = () => false,
  budgetChunks = OPENING_TITLE_CHUNKS,
  onChunk?: (index: number) => void
): Promise<RecordedOpening | null> {
  // Les morceaux du passage, comptés à mesure : tout morceau touché après l'en-tête et l'index.
  let headerRead = false;
  let passage = 0;
  const recorder = new RecordingSource(source, (index) => {
    if (headerRead) passage += 1;
    onChunk?.(index);
  });
  // Sans clé : l'en-tête doit être *lu*, pas repris du cache en mémoire, pour que ses octets soient notés.
  const file = await openMediaFile(recorder);
  const headerChunks = new Set(recorder.touched);
  headerRead = true;
  const video = file.tracks.find((track) => track.type === "video");
  if (!video || shouldStop()) return null;

  const targetUs = Math.max(0, startSeconds) * 1e6;
  const offset = clusterOffsetForTime(file, targetUs, video.number) ?? file.firstClusterOffset ?? file.segmentDataStart;
  const reader = createSampleReader(recorder, file, offset);
  let coveredFrom = Number.POSITIVE_INFINITY;
  let coveredTo = 0;
  for (let n = 0; n < MAX_SAMPLES; n++) {
    if (shouldStop()) return null;
    // Le budget atteint : ce qui est lu jusqu'ici est entier (chaque morceau touché l'est tout entier).
    if (passage >= budgetChunks) break;
    const sample = await reader.next();
    if (!sample) break;
    if (sample.trackNumber === video.number) {
      const at = sample.timestampUs / 1e6;
      coveredFrom = Math.min(coveredFrom, at);
      coveredTo = Math.max(coveredTo, at);
    }
  }
  if (coveredTo < startSeconds + MIN_COVERED_AHEAD_SECONDS && passage >= budgetChunks) {
    return { chunks: [...headerChunks].sort((a, b) => a - b), coveredFrom: 0, coveredTo: 0, partial: true };
  }
  return {
    chunks: [...recorder.touched].sort((a, b) => a - b),
    coveredFrom: Number.isFinite(coveredFrom) ? coveredFrom : startSeconds,
    coveredTo,
    partial: false,
  };
}
