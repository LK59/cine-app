// La source d'octets de Lumen serveur : le fichier lui-même, lu sur le disque en lecture seule.
//
// Derrière l'interface `ByteSource` du lecteur (byteSource.ts : `size`, `read`, `close` suffisent),
// pour qu'un relais Jellyfin (`/Videos/{id}/stream?static=true` + `Range`) puisse la remplacer sans
// que rien au-dessus ne le sache — le repli prévu quand les médias ne sont pas montés (2-serveur.md
// §2.1, option B). Mesuré à l'étude : lire le fichier est 1,3 à 2 fois plus rapide que le relais à
// chaud, équivalent à froid, et Jellyfin sort du chemin des octets.
//
// Un petit cache par morceaux alignés, parce que le démultiplexeur lit par champs : un en-tête
// d'élément (16 octets), puis l'en-tête d'un bloc, puis sa charge. Le prototype faisait une lecture
// système par appel — 170 à 1 600 par segment ; par morceaux, une dizaine. Les lectures longues
// (une image 4K) passent à côté du cache : les copier dans un morceau ne ferait que doubler la mémoire.
//
// Node seulement (`node:fs`). Jamais importé par le code du navigateur.

import { open, type FileHandle } from "node:fs/promises";
import type { ByteSource } from "../webcodecs/byteSource";
import type { FileIdentity } from "./format";

export interface FileSourceStats {
  /** Lectures système. */
  reads: number;
  /** Octets lus sur le disque (morceaux entiers compris). */
  bytes: number;
  /** Temps passé à attendre le disque. */
  ms: number;
}

export interface FileSourceOptions {
  /**
   * La taille d'un morceau du cache. Petite pour un index (on saute de grappe en grappe et n'en lit
   * que les en-têtes : 16 Kio), plus grande pour un segment (on lit tout, dans l'ordre : 256 Kio).
   */
  chunkSize?: number;
  /** Combien de morceaux garder. */
  chunks?: number;
}

const DEFAULT_CHUNK = 256 * 1024;
const DEFAULT_CHUNKS = 16;

export class FileByteSource implements ByteSource {
  readonly stats: FileSourceStats = { reads: 0, bytes: 0, ms: 0 };
  private readonly cache = new Map<number, Uint8Array>();
  private readonly chunkSize: number;
  private readonly maxChunks: number;
  private closed = false;

  private constructor(
    private readonly handle: FileHandle,
    readonly identity: FileIdentity,
    options: FileSourceOptions
  ) {
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK;
    this.maxChunks = options.chunks ?? DEFAULT_CHUNKS;
  }

  /**
   * Ouvre `path` en lecture seule. L'identité vient du descripteur ouvert (`fstat`), pas d'un `stat`
   * fait avant : c'est ce fichier-là qui sera lu, même si un autre prend sa place entre-temps.
   */
  static async open(path: string, options: FileSourceOptions = {}): Promise<FileByteSource> {
    const handle = await open(path, "r");
    try {
      const st = await handle.stat();
      if (!st.isFile()) throw new Error(`Pas un fichier : ${path}`);
      return new FileByteSource(handle, { path, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino }, options);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  get size(): number {
    return this.identity.size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const start = Math.max(0, Math.min(offset, this.size));
    const end = Math.max(start, Math.min(offset + length, this.size));
    if (end === start) return new Uint8Array(0);
    if (end - start >= this.chunkSize / 2) return this.readDirect(start, end - start);

    const first = Math.floor(start / this.chunkSize);
    const last = Math.floor((end - 1) / this.chunkSize);
    if (first === last) {
      const chunk = await this.chunk(first);
      const from = start - first * this.chunkSize;
      return chunk.subarray(from, from + (end - start));
    }
    // À cheval sur deux morceaux : assemblé, rare (un en-tête coupé par la frontière).
    const out = new Uint8Array(end - start);
    let at = start;
    for (let index = first; index <= last; index++) {
      const chunk = await this.chunk(index);
      const from = at - index * this.chunkSize;
      const take = Math.min(chunk.length - from, end - at);
      out.set(chunk.subarray(from, from + take), at - start);
      at += take;
    }
    return out;
  }

  private async chunk(index: number): Promise<Uint8Array> {
    const held = this.cache.get(index);
    if (held) {
      // Remis en tête : le plus ancien *utilisé* part d'abord.
      this.cache.delete(index);
      this.cache.set(index, held);
      return held;
    }
    const start = index * this.chunkSize;
    const bytes = await this.readDirect(start, Math.min(this.chunkSize, this.size - start));
    this.cache.set(index, bytes);
    while (this.cache.size > this.maxChunks) this.cache.delete(this.cache.keys().next().value!);
    return bytes;
  }

  private async readDirect(start: number, length: number): Promise<Uint8Array> {
    if (this.closed) throw new Error("Source fermée.");
    const buffer = new Uint8Array(length);
    const began = performance.now();
    let got = 0;
    // Une lecture courte n'est pas une fin de fichier tant qu'on n'y est pas : on redemande.
    while (got < length) {
      const { bytesRead } = await this.handle.read(buffer, got, length - got, start + got);
      if (bytesRead <= 0) break;
      got += bytesRead;
    }
    this.stats.ms += performance.now() - began;
    this.stats.reads += 1;
    this.stats.bytes += got;
    return got === length ? buffer : buffer.subarray(0, got);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cache.clear();
    void this.handle.close().catch(() => {});
  }
}
