import { open, type FileHandle } from "node:fs/promises";
import type { ByteSource } from "@/lib/webcodecs/byteSource";
import { parseMatroska } from "@/lib/webcodecs/matroska";
import { SampleReader } from "@/lib/webcodecs/sampleReader";
import { isUnreadableZone } from "@/lib/webcodecs/unreadableZone";

/**
 * La relecture d'un fichier pour l'intégrité (DECISIONS.md §93) : le MÊME lecteur que le lecteur
 * natif (`SampleReader`, option `unreadable: "throw"`), donc la MÊME détection — un fichier que
 * cette relecture déclare sain ne lèvera pas de zone au lecteur, et inversement.
 *
 * Lecture séquentielle par grands blocs (8 Mio, deux gardés et un réemployé : 24 Mio de mémoire au
 * plus, plus un élément qui déborderait d'un bloc), dans l'ordre du fichier. Chaque bloc lu du disque passe d'abord
 * par `beforeBlock` — la barrière du moteur : arrêt, attente pendant une lecture, débit plafonné,
 * verrou commun des tâches de fond. La boucle d'événements est rendue toutes les 64 lectures :
 * servies depuis la mémoire, elles ne seraient sinon qu'une chaîne de micro-tâches.
 */

export const BLOCK_BYTES = 8 << 20;
const KEPT_BLOCKS = 2;
const YIELD_EVERY_READS = 64;
/** Au-delà, le fichier est assez abîmé : on s'arrête de compter. */
export const MAX_ZONES = 50;

export interface ZoneFound {
  /** L'instant, sur l'horloge du fichier, en secondes (une décimale). */
  seconds: number;
  /** L'octet de l'en-tête illisible. */
  byte: number;
}

export interface ScanResult {
  zones: ZoneFound[];
  /** Plus de `MAX_ZONES` zones : la liste est tronquée. */
  truncated: boolean;
  /** Une zone sans point d'index après elle : la fin du fichier n'a pas pu être relue. */
  unreachableTail: boolean;
  durationSeconds: number | null;
}

export interface BlockHooks {
  /** Avant chaque lecture réelle du disque — peut attendre, ou lever pour arrêter. */
  beforeBlock(bytes: number): Promise<void>;
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Un fichier du disque, lu par blocs séquentiels — en lecture seule. */
export class SequentialFileSource implements ByteSource {
  private blocks = new Map<number, Uint8Array>();
  /**
   * Les tampons des blocs sortis du cache, réemployés : un tampon neuf de 8 Mio par bloc, c'était
   * 2 Go de déchets par film et des pauses du ramasse-miettes de 50 à 150 ms (mesuré, banc). Sans
   * risque ici : la relecture n'écrit ni ne garde rien des échantillons, et chaque lecture est
   * analysée avant la suivante.
   */
  private spare: Uint8Array[] = [];
  private reads = 0;
  /** Les octets réellement lus du disque. */
  bytesRead = 0;

  private constructor(
    private readonly handle: FileHandle,
    readonly size: number,
    private readonly hooks: BlockHooks
  ) {}

  static async open(path: string, hooks: BlockHooks): Promise<SequentialFileSource> {
    const handle = await open(path, "r");
    try {
      const stat = await handle.stat();
      return new SequentialFileSource(handle, stat.size, hooks);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async block(index: number): Promise<Uint8Array> {
    const kept = this.blocks.get(index);
    if (kept) return kept;
    const start = index * BLOCK_BYTES;
    const length = Math.min(BLOCK_BYTES, this.size - start);
    await this.hooks.beforeBlock(length);
    const reused = this.spare.pop();
    const buffer = reused && reused.length >= length ? reused.subarray(0, length) : new Uint8Array(BLOCK_BYTES).subarray(0, length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await this.handle.read(buffer, done, length - done, start + done);
      if (bytesRead <= 0) break;
      done += bytesRead;
    }
    this.bytesRead += done;
    const bytes = done === length ? buffer : buffer.subarray(0, done);
    this.blocks.set(index, bytes);
    while (this.blocks.size > KEPT_BLOCKS) {
      const oldest = this.blocks.keys().next().value!;
      const out = this.blocks.get(oldest)!;
      this.blocks.delete(oldest);
      if (out.buffer.byteLength === BLOCK_BYTES) this.spare.push(new Uint8Array(out.buffer));
    }
    return bytes;
  }

  async read(offset: number, requested: number): Promise<Uint8Array> {
    if (++this.reads % YIELD_EVERY_READS === 0) await yieldToLoop();
    const length = Math.max(0, Math.min(requested, this.size - offset));
    if (length === 0) return new Uint8Array(0);
    const first = Math.floor(offset / BLOCK_BYTES);
    const last = Math.floor((offset + length - 1) / BLOCK_BYTES);
    if (first === last) {
      const b = await this.block(first);
      const at = offset - first * BLOCK_BYTES;
      return b.subarray(at, Math.min(b.length, at + length));
    }
    const out = new Uint8Array(length);
    let done = 0;
    for (let index = first; index <= last && done < length; index++) {
      const b = await this.block(index);
      const at = offset + done - index * BLOCK_BYTES;
      const n = Math.min(length - done, b.length - at);
      if (n <= 0) break;
      out.set(b.subarray(at, at + n), done);
      done += n;
    }
    return out.subarray(0, done);
  }

  close(): void {
    this.blocks.clear();
    this.spare = [];
    void this.handle.close().catch(() => {});
  }
}

/**
 * Relit tout le film d'un Matroska et rend chaque zone illisible, avec sa position. Après une zone,
 * la relecture reprend au premier point d'index qui la suit — comme un saut du spectateur — et la
 * suivante est trouvée de même.
 */
export async function scanMatroska(source: ByteSource): Promise<ScanResult> {
  const file = await parseMatroska(source);
  const reader = new SampleReader(source, file, file.firstClusterOffset ?? file.segmentDataStart, { unreadable: "throw" });
  const zones: ZoneFound[] = [];
  let truncated = false;
  let unreachableTail = false;
  /** Le point d'index où la relecture vient de reprendre, tant qu'aucun échantillon n'y a été lu. */
  let resumedAt: number | null = null;
  for (;;) {
    try {
      const sample = await reader.next();
      if (!sample) break;
      resumedAt = null;
    } catch (error) {
      if (!isUnreadableZone(error)) throw error;
      // Illisible dès la reprise : la même zone qui continue par-dessus la grappe suivante — une
      // entrée, pas une par grappe touchée.
      if (resumedAt === null || error.byteOffset !== resumedAt) zones.push({ seconds: Math.round(error.seconds * 10) / 10, byte: error.byteOffset });
      if (zones.length >= MAX_ZONES) {
        truncated = true;
        break;
      }
      let next: number | null = null;
      for (const cue of file.cues) if (cue.clusterOffset > error.byteOffset && (next === null || cue.clusterOffset < next)) next = cue.clusterOffset;
      if (next === null) {
        unreachableTail = true;
        break;
      }
      reader.seekTo(next);
      resumedAt = next;
    }
  }
  return { zones, truncated, unreachableTail, durationSeconds: file.durationSeconds };
}

/** Un fichier que cette relecture sait lire : Matroska (et WebM), reconnu au nom. */
export function isMatroskaName(name: string): boolean {
  return /\.(mkv|mk3d|webm)$/i.test(name);
}

/** Un fichier vidéo de la bibliothèque, Matroska ou non. */
export function isVideoName(name: string): boolean {
  return /\.(mkv|mk3d|webm|mp4|m4v|mov|avi|ts|m2ts|wmv)$/i.test(name);
}
