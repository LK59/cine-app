// Random access over a media file, for the experimental WebCodecs player.
//
// The demuxer needs to jump around a file that can be 40 GB: read the header, jump to the end
// for the index, then stream clusters from wherever the user seeks. HTTP range requests give
// exactly that, and the existing Jellyfin stream proxy already forwards Range headers for the
// static (non-transcoded) endpoint — so the original file is reachable with no new route and no
// ffmpeg anywhere in the path.
//
// Everything above this interface is testable without a network: the demuxer only ever sees
// `size` and `read()`, so its tests feed it a Uint8Array.

export interface ByteSource {
  /** Total length of the file in bytes. */
  readonly size: number;
  /** Reads exactly [offset, offset+length), clamped at EOF. */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** Releases any pending work. Safe to call twice. */
  close(): void;
}

/**
 * A window of another source, already in memory, addressed by the SAME absolute offsets.
 *
 * Parsing a container element field by field means one read per field — 129 000 of them for a
 * film with 15 000 cue points, measured. Each is cheap on its own but they are all awaited. When
 * an element is known to be small enough to hold whole (Tracks, Cues), reading it once and
 * parsing out of the buffer turns those thousands of reads into one, with no change to the
 * parsing code: it keeps handing out the same absolute offsets.
 */
export class SlicedSource implements ByteSource {
  constructor(private readonly bytes: Uint8Array, private readonly base: number, readonly size: number) {}

  static async of(source: ByteSource, start: number, end: number): Promise<SlicedSource> {
    const bytes = await source.read(start, end - start);
    return new SlicedSource(bytes, start, source.size);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const from = offset - this.base;
    const start = Math.max(0, Math.min(from, this.bytes.length));
    const to = Math.max(start, Math.min(from + length, this.bytes.length));
    return this.bytes.subarray(start, to);
  }

  close(): void {}
}

export class MemoryByteSource implements ByteSource {
  constructor(private readonly bytes: Uint8Array) {}
  get size() {
    return this.bytes.length;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    const start = Math.max(0, Math.min(offset, this.bytes.length));
    const end = Math.max(start, Math.min(offset + length, this.bytes.length));
    return this.bytes.subarray(start, end);
  }
  close(): void {}
}

// Reads are coalesced into fixed-size chunks and cached: a demuxer asks for a 4-byte element
// header, then a 3-byte size, then a payload — issuing an HTTP request per call would be
// thousands of round-trips. One chunk fetch answers hundreds of those.
const CHUNK_SIZE = 1 << 20; // 1 MiB
const MAX_CACHED_CHUNKS = 32; // ~32 MiB ceiling, enough to cover a seek's working set

export class HttpByteSource implements ByteSource {
  readonly size: number;
  private readonly url: string;
  private readonly chunks = new Map<number, Uint8Array>();
  private readonly inflight = new Map<number, Promise<Uint8Array>>();
  private readonly controller = new AbortController();

  private constructor(url: string, size: number) {
    this.url = url;
    this.size = size;
  }

  // The length has to come from the server before anything else can be parsed. HEAD is tried
  // first because it costs nothing; some proxies answer it without Content-Length, in which case
  // a one-byte ranged GET gets the total out of Content-Range instead.
  static async open(url: string): Promise<HttpByteSource> {
    const head = await fetch(url, { method: "HEAD" });
    const headLength = Number(head.headers.get("Content-Length"));
    if (head.ok && Number.isFinite(headLength) && headLength > 0) {
      return new HttpByteSource(url, headLength);
    }

    const probe = await fetch(url, { headers: { Range: "bytes=0-0" } });
    const contentRange = probe.headers.get("Content-Range");
    const total = contentRange ? Number(contentRange.split("/")[1]) : NaN;
    if (!Number.isFinite(total) || total <= 0) {
      throw new Error("Le serveur ne fournit pas la taille du fichier (Content-Range absent).");
    }
    return new HttpByteSource(url, total);
  }

  private async fetchChunk(index: number): Promise<Uint8Array> {
    const cached = this.chunks.get(index);
    if (cached) return cached;
    const pending = this.inflight.get(index);
    if (pending) return pending;

    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, this.size) - 1;
    const promise = fetch(this.url, {
      headers: { Range: `bytes=${start}-${end}` },
      signal: this.controller.signal,
    })
      .then(async (res) => {
        // 206 is the expected answer; a 200 means the server ignored the Range and sent the whole
        // file, which for a 40 GB movie must not be treated as a successful chunk read.
        if (res.status !== 206) throw new Error(`Le serveur n'honore pas les requêtes de plage (statut ${res.status}).`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        this.chunks.set(index, bytes);
        // Oldest-first eviction: Map preserves insertion order, and a demuxer's access pattern is
        // overwhelmingly forward, so the oldest chunk is reliably the least useful one.
        while (this.chunks.size > MAX_CACHED_CHUNKS) {
          const oldest = this.chunks.keys().next().value;
          if (oldest === undefined) break;
          this.chunks.delete(oldest);
        }
        return bytes;
      })
      .finally(() => this.inflight.delete(index));

    this.inflight.set(index, promise);
    return promise;
  }

  /**
   * Starts fetching the chunk after the one just used, without waiting for it.
   *
   * Playback reads strictly forward, and a 1 MiB chunk is well under a second of 4K video — so
   * without this, every chunk boundary is a full network round trip the decoder sits through.
   * That stall is what turns a decoder that can keep up into one that visibly cannot.
   */
  private prefetchAfter(index: number): void {
    const next = index + 1;
    if (next * CHUNK_SIZE >= this.size) return;
    if (this.chunks.has(next) || this.inflight.has(next)) return;
    void this.fetchChunk(next).catch(() => {
      // A failed read-ahead is not an error: the real read will try again and report properly.
    });
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const start = Math.max(0, Math.min(offset, this.size));
    const end = Math.max(start, Math.min(offset + length, this.size));
    if (end === start) return new Uint8Array(0);

    const firstChunk = Math.floor(start / CHUNK_SIZE);
    const lastChunk = Math.floor((end - 1) / CHUNK_SIZE);

    // Fast path: the whole read sits inside one chunk, so it's a view, not a copy.
    if (firstChunk === lastChunk) {
      const chunk = await this.fetchChunk(firstChunk);
      this.prefetchAfter(firstChunk);
      const from = start - firstChunk * CHUNK_SIZE;
      return chunk.subarray(from, from + (end - start));
    }

    const out = new Uint8Array(end - start);
    let written = 0;
    for (let index = firstChunk; index <= lastChunk; index++) {
      const chunk = await this.fetchChunk(index);
      const chunkStart = index * CHUNK_SIZE;
      const from = Math.max(0, start - chunkStart);
      const to = Math.min(chunk.length, end - chunkStart);
      if (to > from) {
        out.set(chunk.subarray(from, to), written);
        written += to - from;
      }
    }
    this.prefetchAfter(lastChunk);
    return written === out.length ? out : out.subarray(0, written);
  }

  close(): void {
    this.controller.abort();
    this.chunks.clear();
    this.inflight.clear();
  }
}
