import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HttpByteSource } from "@/lib/webcodecs/byteSource";

// The transport under a demuxer that asks for four bytes at a time. What matters here is not what
// comes back — it is how many round trips it took and whether they overlapped, because on a real
// link that is almost the whole of the wait before a film starts.

const CHUNK = 1 << 20;
const SIZE = 10 * CHUNK;

/** Ranges asked for, in order, with a hook to hold answers open. */
let asked: [number, number][] = [];
let hold: ((value: void) => void) | null = null;
let inFlight = 0;
let peakInFlight = 0;

function stubFetch(options: { rangeStatus?: number; contentLength?: string | null } = {}) {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit & { headers?: Record<string, string> }) => {
    if (init?.method === "HEAD") {
      return {
        ok: true,
        headers: { get: (name: string) => (name === "Content-Length" ? (options.contentLength ?? String(SIZE)) : null) },
      };
    }
    const range = init?.headers?.Range ?? "";
    const [, from, to] = /bytes=(\d+)-(\d+)/.exec(range)!.map(Number);
    asked.push([from, to]);

    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    if (hold) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;

    return {
      status: options.rangeStatus ?? 206,
      headers: { get: () => `bytes ${from}-${to}/${SIZE}` },
      arrayBuffer: async () => new Uint8Array(to - from + 1).buffer,
    };
  });
}

beforeEach(() => {
  asked = [];
  hold = null;
  inFlight = 0;
  peakInFlight = 0;
});
afterEach(() => vi.unstubAllGlobals());

const chunksAsked = () => [...new Set(asked.map(([from]) => from / CHUNK))].sort((a, b) => a - b);
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("HttpByteSource", () => {
  it("fetches both ends of the file before anyone asks", async () => {
    // A Matroska file is read from the front for its header and from wherever the Cues were
    // written for its index, which on a file made for streaming is the very end. Fetched one
    // after the other, those two were most of the second between opening a file and knowing
    // what was in it.
    stubFetch();
    const source = await HttpByteSource.open("/film.mkv");
    await settle();

    expect(chunksAsked()).toContain(0);
    expect(chunksAsked()).toContain(9);
    source.close();
  });

  it("answers hundreds of small reads from one fetch", async () => {
    // A demuxer asks for a four-byte element header, then a three-byte size, then a payload. One
    // request per call would be thousands of round trips.
    stubFetch();
    const source = await HttpByteSource.open("/film.mkv");
    await settle();
    asked = [];

    for (let at = 0; at < 4096; at += 4) await source.read(at, 4);
    // A thousand reads, and not one of them asked for the chunk they all sit in — it was already
    // held. What is asked for is only ever the read-ahead running in front of them.
    expect(chunksAsked()).not.toContain(0);
    expect(asked.length).toBeLessThanOrEqual(8);
    source.close();
  });

  it("reads ahead far enough to keep the link busy", async () => {
    // One chunk ahead is a relay, not a pipeline: every megabyte after the first pays a fresh
    // round trip before its first byte arrives. Reading one keyframe group means five or six.
    stubFetch();
    const source = await HttpByteSource.open("/film.mkv");
    await settle();
    asked = [];

    await source.read(2 * CHUNK, 16);
    await settle();
    // The chunk itself, and several after it.
    expect(chunksAsked().length).toBeGreaterThanOrEqual(5);
    expect(chunksAsked()).toContain(2);
    expect(chunksAsked()).toContain(3);
    source.close();
  });

  it("asks for the chunks of one read together, not one after another", async () => {
    stubFetch();
    hold = () => {};
    const source = await HttpByteSource.open("/film.mkv");
    await settle();
    peakInFlight = 0;

    // A read spanning four chunks used to be four round trips deep.
    await source.read(4 * CHUNK, 3 * CHUNK + 10);
    expect(peakInFlight).toBeGreaterThan(1);
    source.close();
  });

  it("asks again for a range that failed to arrive", async () => {
    // A range request is not a stream: nothing resumes it, and one refused fetch used to travel
    // all the way up as the player giving up. A phone moving from Wi-Fi to mobile drops every
    // connection it has, which is an ordinary thing to do while watching a film.
    let refusals = 2;
    stubFetch();
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if ((init as { method?: string } | undefined)?.method !== "HEAD" && refusals-- > 0) {
        throw new TypeError("Failed to fetch");
      }
      return (real as typeof fetch)(url as unknown as RequestInfo, init);
    });

    const source = await HttpByteSource.open("/film.mkv");
    const bytes = await source.read(3 * CHUNK, 32);
    expect(bytes.length).toBe(32);
    expect(refusals).toBeLessThanOrEqual(0);
    source.close();
  }, 15000);

  it("gives up at once on a server that does not do ranges at all", async () => {
    // 200 is not a bad moment: asking again would only download a forty-gigabyte film four times.
    stubFetch({ rangeStatus: 200 });
    const source = await HttpByteSource.open("/film.mkv");
    await expect(source.read(0, 16)).rejects.toThrow(/plage/);
    // Asked once for that chunk and never again — a retry here downloads the film a second time.
    expect(asked.filter(([from]) => from === 0).length).toBe(1);
    source.close();
  });

  it("refuses a server that ignores the range and sends the whole file", async () => {
    // 200 on a 40 GB film is not a successful chunk read, it is a download nobody asked for.
    stubFetch({ rangeStatus: 200 });
    const source = await HttpByteSource.open("/film.mkv");
    await expect(source.read(0, 16)).rejects.toThrow(/plage/);
    source.close();
  });

  it("takes the size from Content-Range when HEAD does not give it", async () => {
    stubFetch({ contentLength: null });
    const source = await HttpByteSource.open("/film.mkv");
    expect(source.size).toBe(SIZE);
    source.close();
  });
});
