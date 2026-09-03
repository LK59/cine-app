import { trace } from "./trace";
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

/**
 * How many chunks to keep. Enough to cover a seek's working set, and a ceiling on the memory a
 * long film can quietly accumulate.
 */
const MAX_CACHED_CHUNKS = 48; // ~48 MiB

/**
 * How far ahead to fetch, in chunks.
 *
 * One was not a pipeline, it was a relay: chunk N being consumed while N+1 was in flight, and
 * every megabyte after that paying a fresh round trip before its first byte arrived. Reading one
 * keyframe group means five or six of these, and on the phone that came to 2.6 seconds against
 * 40 ms of actual muxing — the wait was almost entirely the shape of the fetching.
 *
 * Six is chosen against what the reader is for: the fill loop wants thirty seconds of media, which
 * on this library is twenty megabytes, so six ahead is never speculative in the sense of being
 * thrown away. It is only ever bytes that were going to be asked for a moment later.
 */
const PREFETCH_CHUNKS = 6;

/**
 * How a chunk that fails to arrive is retried.
 *
 * A range request is not a stream: nothing resumes it, and one refused fetch used to travel all
 * the way up as a read failure — through the fill loop, through the recovery, and out the other
 * side as the player giving up. A phone changing from Wi-Fi to mobile drops every connection it
 * has, which is a perfectly ordinary thing to do while watching a film and no reason at all to
 * abandon hardware decoding for the rest of it.
 */
const FETCH_ATTEMPTS = 4;
const FETCH_BACKOFF_MS = [200, 600, 1500];

/** How long a read waits for the network to come back before admitting it is not going to. */
const OFFLINE_PATIENCE_MS = 60_000;

/**
 * A read that failed for want of a network, told apart from one that failed for want of sense.
 *
 * The difference decides what happens next, and getting it wrong is worse than either: handing
 * the file to the stable player because the Wi-Fi dropped abandons hardware decoding for a
 * reason that has nothing to do with it — and hands the file to a player that needs the very
 * same network to do anything at all.
 */
export class NetworkUnavailable extends Error {
  readonly network = true;
  constructor(message: string) {
    super(message);
    this.name = "NetworkUnavailable";
  }
}

/** Whether a failure was the network's rather than the media's. */
export function isNetworkFailure(error: unknown): boolean {
  return error instanceof Error && "network" in error && error.network === true;
}

/**
 * Waits for the browser to say it is connected again, up to a point.
 *
 * Retrying while the machine knows it has no network is a way of spending attempts on nothing.
 * Waiting for the event costs neither requests nor battery, and a viewer walking between two
 * networks is back within a second or two.
 */
async function waitForNetwork(): Promise<void> {
  if (typeof navigator === "undefined" || navigator.onLine !== false) return;
  trace("réseau : hors ligne, la lecture attend le retour");
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("online", done);
      resolve();
    };
    const timer = setTimeout(done, OFFLINE_PATIENCE_MS);
    window.addEventListener("online", done, { once: true });
  });
  trace("réseau : de retour");
}

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
      return HttpByteSource.warmed(url, headLength);
    }

    const probe = await fetch(url, { headers: { Range: "bytes=0-0" } });
    const contentRange = probe.headers.get("Content-Range");
    const total = contentRange ? Number(contentRange.split("/")[1]) : NaN;
    if (!Number.isFinite(total) || total <= 0) {
      throw new Error("Le serveur ne fournit pas la taille du fichier (Content-Range absent).");
    }
    return HttpByteSource.warmed(url, total);
  }

  /**
   * Starts the two fetches every Matroska file begins with, before anyone asks for them.
   *
   * Reading the header means the front of the file; reading the index means wherever the Cues
   * were written, which for a file made for streaming is the very end. Those two were fetched one
   * after the other, each paying its own round trip, and together they were most of the second
   * that passed between opening a file and knowing what was in it. Asked for together they cost
   * one round trip instead of two.
   *
   * Neither is awaited: a file whose Cues are at the front simply leaves the tail chunk unused,
   * which costs a megabyte and no time at all.
   */
  private static warmed(url: string, size: number): HttpByteSource {
    const source = new HttpByteSource(url, size);
    const last = Math.floor((size - 1) / CHUNK_SIZE);
    for (const index of last > 0 ? [0, last] : [0]) {
      void source.fetchChunk(index).catch(() => {
        // Speculative. The real read will ask again and report properly if it fails.
      });
    }
    return source;
  }

  /**
   * One range, fetched until it arrives or until there is reason to believe it never will.
   *
   * A server that answers 200 to a Range header is not having a bad moment — it does not honour
   * ranges at all, and asking again would only download a forty-gigabyte film four times.
   */
  private async fetchWithRetries(start: number, end: number): Promise<Uint8Array> {
    let last: unknown;
    for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await waitForNetwork();
        await new Promise((resolve) => setTimeout(resolve, FETCH_BACKOFF_MS[attempt - 1] ?? 1500));
        if (this.controller.signal.aborted) throw last ?? new Error("lecture annulée");
      }
      try {
        const res = await fetch(this.url, {
          headers: { Range: `bytes=${start}-${end}` },
          signal: this.controller.signal,
        });
        // 206 is the expected answer; a 200 means the server ignored the Range and sent the whole
        // file, which for a 40 GB movie must not be treated as a successful chunk read.
        if (res.status === 200) {
          throw new Error("Le serveur n'honore pas les requêtes de plage (statut 200).");
        }
        if (res.status !== 206) throw new Error(`Le serveur a refusé la plage demandée (statut ${res.status}).`);
        return new Uint8Array(await res.arrayBuffer());
      } catch (error) {
        // Cancelled by the player itself, and a server that ignores ranges: neither improves by
        // being asked again.
        if (this.controller.signal.aborted) throw error;
        if (error instanceof Error && error.message.includes("statut 200")) throw error;
        last = error;
        if (attempt === 0) trace(`réseau : plage ${start}-${end} refusée, nouvelle tentative`);
      }
    }
    throw new NetworkUnavailable(
      last instanceof Error ? `Plage inaccessible : ${last.message}` : "Plage inaccessible."
    );
  }

  private async fetchChunk(index: number): Promise<Uint8Array> {
    const cached = this.chunks.get(index);
    if (cached) return cached;
    const pending = this.inflight.get(index);
    if (pending) return pending;

    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, this.size) - 1;
    const promise = this.fetchWithRetries(start, end)
      .then((bytes) => {
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
    for (let ahead = 1; ahead <= PREFETCH_CHUNKS; ahead++) {
      const next = index + ahead;
      if (next * CHUNK_SIZE >= this.size) return;
      if (this.chunks.has(next) || this.inflight.has(next)) continue;
      void this.fetchChunk(next).catch(() => {
        // A failed read-ahead is not an error: the real read will try again and report properly.
      });
    }
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

    // Asked for together, not one after the other. Awaiting each in turn made a read spanning
    // four chunks four round trips deep, which is exactly the shape this cache exists to avoid.
    const pending: Promise<Uint8Array>[] = [];
    for (let index = firstChunk; index <= lastChunk; index++) pending.push(this.fetchChunk(index));
    const fetched = await Promise.all(pending);

    const out = new Uint8Array(end - start);
    let written = 0;
    for (let index = firstChunk; index <= lastChunk; index++) {
      const chunk = fetched[index - firstChunk];
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
