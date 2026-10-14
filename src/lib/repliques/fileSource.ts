import fs from "node:fs/promises";
import type { ByteSource } from "@/lib/webcodecs/byteSource";

/**
 * Un fichier du disque, lu par plages, pour l'indexation des répliques (DECISIONS.md §88).
 *
 * Le démultiplexeur du lecteur ne voit qu'un `ByteSource` — `size` et `read()` —, si bien que le même
 * analyseur Matroska lit ici un fichier local au lieu d'une adresse HTTP. Ce qui change tient en trois
 * points, et chacun vient de la mesure du 14/10/2026 :
 *
 * 1. **Une lecture physique coûte un déplacement de tête** (~4 ms sur ces disques), quelle que soit sa
 *    taille jusqu'à quelques centaines de kilo-octets. Les demandes sont donc servies par morceaux
 *    alignés gardés en mémoire, et les morceaux manquants contigus partent en une seule lecture.
 * 2. **Chaque lecture physique passe d'abord par la barrière** (`gate`) : c'est là que l'indexation
 *    s'arrête quand l'administrateur la met en pause, et qu'elle attend pendant qu'un film est regardé.
 *    Au milieu d'un fichier comme entre deux.
 * 3. **On compte** : lectures, octets — la progression affiche les données lues, et le coût d'un film
 *    se relit dans `films.bytes_read`.
 *
 * Deux tailles de morceau : 4 Kio pour la lecture ciblée (en-tête, index, une réplique), 4 Mio pour
 * la lecture complète d'un vieux fichier sans index, qui parcourt tout le film d'un bout à l'autre.
 */

export type ReadGate = (bytes: number) => Promise<void>;

export interface FileSourceOptions {
  /** Taille d'un morceau gardé. */
  chunkBytes?: number;
  /** Combien de morceaux au plus en mémoire (le plus ancien part). */
  maxChunks?: number;
  /** Appelée avant chaque lecture physique, avec sa taille — pause, attente, freinage. */
  gate?: ReadGate;
}

const MAX_READ = 64 * 1024 * 1024;
export const TARGETED_CHUNK = 4 * 1024;
export const SCAN_CHUNK = 4 * 1024 * 1024;

export class FileByteSource implements ByteSource {
  /** Lectures physiques faites. */
  reads = 0;
  /** Octets lus sur le disque. */
  bytesRead = 0;
  private readonly chunks = new Map<number, Uint8Array>();
  private readonly chunkBytes: number;
  private readonly maxChunks: number;
  private readonly gate: ReadGate | undefined;
  private closed = false;

  private constructor(private readonly handle: fs.FileHandle, readonly size: number, options: FileSourceOptions) {
    this.chunkBytes = options.chunkBytes ?? TARGETED_CHUNK;
    this.maxChunks = options.maxChunks ?? 256;
    this.gate = options.gate;
  }

  static async open(path: string, options: FileSourceOptions = {}): Promise<FileByteSource> {
    const handle = await fs.open(path, "r");
    try {
      const stat = await handle.stat();
      return new FileByteSource(handle, stat.size, options);
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (this.closed) throw new Error("Fichier déjà fermé.");
    const start = Math.max(0, Math.min(offset, this.size));
    const end = Math.max(start, Math.min(offset + length, this.size));
    if (end === start) return new Uint8Array(0);
    // Une demande de plus de 64 Mio vient d'une taille mal lue, jamais d'un vrai élément recherché ici.
    if (end - start > MAX_READ) throw new Error(`Lecture refusée : ${end - start} octets demandés.`);
    const first = Math.floor(start / this.chunkBytes);
    const last = Math.floor((end - 1) / this.chunkBytes);

    // Les morceaux manquants, par suites contiguës : une suite = une lecture physique.
    let run: number | null = null;
    for (let index = first; index <= last + 1; index++) {
      const missing = index <= last && !this.chunks.has(index);
      if (missing && run === null) run = index;
      if (!missing && run !== null) {
        await this.fill(run, index - 1);
        run = null;
      }
    }

    if (first === last) {
      const chunk = await this.chunkAt(first);
      this.touch(first, chunk);
      const base = first * this.chunkBytes;
      return chunk.subarray(start - base, end - base);
    }
    const out = new Uint8Array(end - start);
    for (let index = first; index <= last; index++) {
      const chunk = await this.chunkAt(index);
      this.touch(index, chunk);
      const base = index * this.chunkBytes;
      const from = Math.max(start, base);
      const to = Math.min(end, base + chunk.length);
      out.set(chunk.subarray(from - base, to - base), from - start);
    }
    return out;
  }

  /** Lit les morceaux `from`..`to` d'un seul tenant. */
  private async fill(from: number, to: number): Promise<void> {
    const offset = from * this.chunkBytes;
    const length = Math.min(this.size, (to + 1) * this.chunkBytes) - offset;
    if (this.gate) await this.gate(length);
    if (this.closed) throw new Error("Fichier déjà fermé.");
    const buffer = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await this.handle.read(buffer, done, length - done, offset + done);
      if (bytesRead === 0) break;
      done += bytesRead;
    }
    this.reads++;
    this.bytesRead += done;
    for (let index = from; index <= to; index++) {
      const base = index * this.chunkBytes - offset;
      this.chunks.set(index, buffer.subarray(base, Math.min(done, base + this.chunkBytes)));
    }
    while (this.chunks.size > this.maxChunks) this.chunks.delete(this.chunks.keys().next().value!);
  }

  /** Un morceau, relu s'il a été évincé entre-temps par une demande plus large que le cache. */
  private async chunkAt(index: number): Promise<Uint8Array> {
    const known = this.chunks.get(index);
    if (known) return known;
    await this.fill(index, index);
    return this.chunks.get(index) ?? new Uint8Array(0);
  }

  private touch(index: number, chunk: Uint8Array): void {
    this.chunks.delete(index);
    this.chunks.set(index, chunk);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.chunks.clear();
    void this.handle.close().catch(() => {});
  }
}
