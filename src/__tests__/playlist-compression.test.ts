import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

// DECISIONS.md §76 — les listes `.m3u8` compressées par la route quand le client l'accepte, sans
// changer un octet de leur contenu ni rien d'autre du relais (adresses, laissez-passer, CORS,
// segments).

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
vi.mock("@/lib/itemVisibility", () => ({ assertVisible: async () => null }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
vi.mock("@/lib/config", () => ({
  config: {
    player: { enabled: true },
    jellyfin: { url: "http://jf.test", apiKey: "key" },
    app: { sessionSecret: "secret-de-test-assez-long-pour-signer" },
  },
}));
vi.mock("@/lib/castProgress", () => ({ castProgressRelay: () => ({ noteCastSegment: vi.fn(), notePageReport: vi.fn() }) }));

const mockFetch = vi.fn();
const itemId = "c".repeat(32);

/** La forme relevée sur le vrai serveur le 12/10/2026 : toute la requête recopiée sur chaque segment. */
const QUERY =
  `DeviceId=cine-app-x&MediaSourceId=${itemId}&VideoCodec=h264,vp9,av1&AudioCodec=aac&AudioStreamIndex=3&VideoBitrate=1116000` +
  "&AudioBitrate=384000&MaxFramerate=25&SegmentContainer=mp4&PlaySessionId=p&TranscodingMaxAudioChannels=6&RequireAvc=false" +
  "&h264-rangetype=SDR,HDR10,HDR10Plus,HLG,DOVIWithHDR10,DOVIWithHDR10Plus,DOVIWithSDR&TranscodeReasons=AudioCodecNotSupported";
function mainPlaylist(segments: number): string {
  const lines = ["#EXTM3U", "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:3", "#EXT-X-MEDIA-SEQUENCE:0"];
  lines.push(`#EXT-X-MAP:URI="hls1/main/-1.mp4?${QUERY}&runtimeTicks=0&actualSegmentLengthTicks=30000000"`);
  for (let i = 0; i < segments; i++) {
    lines.push("#EXTINF:3.000000, nodesc", `hls1/main/${i}.mp4?${QUERY}&runtimeTicks=${i * 30000000}&actualSegmentLengthTicks=30000000`);
  }
  lines.push("#EXT-X-ENDLIST", "");
  return lines.join("\n");
}

function req(url: string, { cookie, acceptEncoding }: { cookie: string | null; acceptEncoding?: string }): NextRequest {
  const parsed = new URL(url);
  const headers = new Headers({ host: "cine.example" });
  if (acceptEncoding !== undefined) headers.set("accept-encoding", acceptEncoding);
  return {
    method: "GET",
    url: parsed.toString(),
    cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) },
    headers,
    nextUrl: parsed,
    signal: new AbortController().signal,
  } as unknown as NextRequest;
}

function upstream(body: string, type = "application/vnd.apple.mpegurl") {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({ start: (c) => c.close() }),
    headers: new Headers({ "Content-Type": type }),
    text: async () => body,
  };
}

async function get(url: string, path: string[], opts: { cookie: string | null; acceptEncoding?: string }) {
  const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
  const res = await GET(req(url, opts), { params: Promise.resolve({ itemId, path }) });
  return { res, bytes: Buffer.from(await res.arrayBuffer()) };
}

function decode(res: Response, bytes: Buffer): string {
  const encoding = res.headers.get("Content-Encoding");
  if (encoding === "gzip") return gunzipSync(bytes).toString("utf-8");
  if (encoding === "br") return brotliDecompressSync(bytes).toString("utf-8");
  return bytes.toString("utf-8");
}

async function pass() {
  const { signCastToken } = await import("@/lib/castToken");
  return encodeURIComponent(await signCastToken(itemId, "louis"));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
  mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
});

describe("playlistEncodingFor", () => {
  it("brotli d'abord, puis gzip, et rien sans en-tête", async () => {
    const { playlistEncodingFor } = await import("@/lib/playlistEncoding");
    expect(playlistEncodingFor("gzip, deflate, br, zstd")).toBe("br");
    expect(playlistEncodingFor("gzip, deflate")).toBe("gzip");
    expect(playlistEncodingFor("identity")).toBeNull();
    expect(playlistEncodingFor("")).toBeNull();
    expect(playlistEncodingFor(null)).toBeNull();
  });

  it("un codage refusé (q=0) ne compte pas, `*` vaut pour les deux", async () => {
    const { playlistEncodingFor } = await import("@/lib/playlistEncoding");
    expect(playlistEncodingFor("br;q=0, gzip;q=0.8")).toBe("gzip");
    expect(playlistEncodingFor("br;q=0, gzip;q=0")).toBeNull();
    expect(playlistEncodingFor("*")).toBe("br");
    expect(playlistEncodingFor("*;q=0")).toBeNull();
  });
});

describe("route de flux — compression des listes .m3u8", () => {
  // Un épisode de 41 min : 826 segments de 3 s, comme celui du 12/10/2026.
  const playlist = mainPlaylist(826);
  const url = `https://cine.example/api/jellyfin/stream/${itemId}/main.m3u8?${QUERY}`;

  it("sans Accept-Encoding : en clair, comme avant", async () => {
    mockFetch.mockResolvedValue(upstream(playlist));
    const { res, bytes } = await get(url, ["main.m3u8"], { cookie: "t" });
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(bytes.toString("utf-8")).toBe(playlist);
    expect(res.headers.get("Content-Length")).toBe(String(bytes.length));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("application/vnd.apple.mpegurl");
  });

  for (const [acceptEncoding, expected] of [
    ["gzip, deflate", "gzip"],
    ["gzip, deflate, br, zstd", "br"],
  ] as const) {
    it(`${acceptEncoding} : ${expected}, et le texte décompressé est celui d'avant octet pour octet`, async () => {
      mockFetch.mockResolvedValue(upstream(playlist));
      const plain = await get(url, ["main.m3u8"], { cookie: "t" });
      mockFetch.mockResolvedValue(upstream(playlist));
      const { res, bytes } = await get(url, ["main.m3u8"], { cookie: "t", acceptEncoding });
      expect(res.headers.get("Content-Encoding")).toBe(expected);
      expect(res.headers.get("Vary")).toBe("Accept-Encoding");
      expect(res.headers.get("Content-Length")).toBe(String(bytes.length));
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(decode(res, bytes)).toBe(plain.bytes.toString("utf-8"));
      // L'ordre de grandeur mesuré sur la vraie liste : ~700 Ko en clair, moins de 15 Ko compressés.
      expect(plain.bytes.length).toBeGreaterThan(400_000);
      expect(bytes.length).toBeLessThan(15_000);
    });
  }

  it("un téléviseur muni d'un laissez-passer reçoit le même contenu, signé, avec ses en-têtes CORS", async () => {
    const token = await pass();
    const tvUrl = `${url}&castToken=${token}`;
    mockFetch.mockResolvedValue(upstream(playlist));
    const plain = await get(tvUrl, ["main.m3u8"], { cookie: null });
    mockFetch.mockResolvedValue(upstream(playlist));
    const { res, bytes } = await get(tvUrl, ["main.m3u8"], { cookie: null, acceptEncoding: "gzip, deflate, br" });

    const text = decode(res, bytes);
    expect(text).toBe(plain.bytes.toString("utf-8"));
    // Chaque segment garde son laissez-passer : la réécriture n'a pas bougé.
    const segments = text.split("\n").filter((l) => l.startsWith("hls1/"));
    expect(segments).toHaveLength(826);
    expect(segments.every((l) => l.endsWith(`&castToken=${token}`))).toBe(true);
    // Les mêmes en-têtes de diffusion qu'en clair.
    for (const name of ["Access-Control-Allow-Origin", "Access-Control-Expose-Headers", "Access-Control-Allow-Credentials"]) {
      expect(res.headers.get(name)).toBe(plain.res.headers.get(name));
    }
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("un petit maître part en clair : la compression n'y gagnerait rien", async () => {
    const master = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmain.m3u8?PlaySessionId=p\n`;
    mockFetch.mockResolvedValue(upstream(master));
    const { res, bytes } = await get(`https://cine.example/api/jellyfin/stream/${itemId}/master.m3u8`, ["master.m3u8"], {
      cookie: "t",
      acceptEncoding: "gzip, br",
    });
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(bytes.toString("utf-8")).toBe(master);
  });

  it("les segments ne sont jamais compressés", async () => {
    mockFetch.mockResolvedValue(upstream("x".repeat(5000), "video/mp4"));
    const { res } = await get(`https://cine.example/api/jellyfin/stream/${itemId}/hls1/main/0.mp4?${QUERY}`, ["hls1", "main", "0.mp4"], {
      cookie: "t",
      acceptEncoding: "gzip, br",
    });
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(res.headers.get("Vary")).toBeNull();
  });
});
