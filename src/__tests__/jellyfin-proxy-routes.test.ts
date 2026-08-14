import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/config", () => ({
  config: {
    jellyfin: { url: "http://jellyfin.local", apiKey: "key" },
    get player() { return { enabled: playerEnabled }; },
  },
}));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerifySessionFull(...a) }));

let playerEnabled = true;
const originalFetch = global.fetch;
const validId = "a".repeat(32);

function fakeReq(opts: { search?: string; cookie?: string; range?: string } = {}): NextRequest {
  return {
    signal: new AbortController().signal,
    nextUrl: { searchParams: new URLSearchParams(opts.search ?? ""), search: opts.search ? `?${opts.search}` : "" },
    cookies: { get: (name: string) => (name === "cine_session" && opts.cookie ? { value: opts.cookie } : undefined) },
    headers: { get: (name: string) => (name.toLowerCase() === "range" ? opts.range ?? null : null) },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  playerEnabled = true;
});
afterEach(() => { global.fetch = originalFetch; });

describe("GET /api/jellyfin/image", () => {
  it("returns 400 for a malformed itemId", async () => {
    const { GET } = await import("@/app/api/jellyfin/image/route");
    const res = await GET(fakeReq({ search: "itemId=not-hex" }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when Jellyfin has no image for this item", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false });
    const { GET } = await import("@/app/api/jellyfin/image/route");
    const res = await GET(fakeReq({ search: `itemId=${validId}` }));
    expect(res.status).toBe(404);
  });

  it("returns 502 when the fetch itself throws (network error)", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("down"));
    const { GET } = await import("@/app/api/jellyfin/image/route");
    const res = await GET(fakeReq({ search: `itemId=${validId}` }));
    expect(res.status).toBe(502);
  });

  it("passes through the upstream content-type on success", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["x"]),
      headers: new Headers({ "Content-Type": "image/webp" }),
    });
    const { GET } = await import("@/app/api/jellyfin/image/route");
    const res = await GET(fakeReq({ search: `itemId=${validId}` }));
    expect(res.headers.get("content-type")).toBe("image/webp");
  });
});

describe("GET /api/jellyfin/stream/[itemId]/[...path]", () => {
  it("returns 404 when the in-app player is disabled", async () => {
    playerEnabled = false;
    const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
    const res = await GET(fakeReq(), { params: Promise.resolve({ itemId: validId, path: ["master.m3u8"] }) });
    expect(res.status).toBe(404);
  });

  it("returns 403 without a Jellyfin session", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
    const res = await GET(fakeReq(), { params: Promise.resolve({ itemId: validId, path: ["master.m3u8"] }) });
    expect(res.status).toBe(403);
  });

  it("rewrites absolute /videos/{itemId}/ references inside an HLS manifest back through our proxy", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: {},
      headers: new Headers({ "Content-Type": "application/vnd.apple.mpegurl" }),
      text: async () => `#EXTM3U\nhttp://jellyfin.local/videos/${validId}/segment1.ts\n/videos/${validId}/segment2.ts\n`,
    });
    const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
    const res = await GET(fakeReq(), { params: Promise.resolve({ itemId: validId, path: ["master.m3u8"] }) });
    const text = await res.text();
    expect(text).toContain(`/api/jellyfin/stream/${validId}/segment1.ts`);
    expect(text).toContain(`/api/jellyfin/stream/${validId}/segment2.ts`);
    expect(text).not.toContain("jellyfin.local");
  });

  it("streams a non-manifest segment through with a long-lived immutable cache header", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: {},
      headers: new Headers({ "Content-Type": "video/mp2t" }),
    });
    const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
    const res = await GET(fakeReq(), { params: Promise.resolve({ itemId: validId, path: ["segment1.ts"] }) });
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("forwards the client's Range header to Jellyfin (DirectPlay/DirectStream native seeking)", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 206,
      body: {},
      headers: new Headers({ "Content-Type": "video/x-matroska" }),
    });
    const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
    await GET(fakeReq({ search: "static=true", range: "bytes=100-199" }), {
      params: Promise.resolve({ itemId: validId, path: ["stream.mkv"] }),
    });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers.Range).toBe("bytes=100-199");
  });

  it("passes through the real status and Content-Range for a static (DirectPlay/DirectStream) request", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 206,
      body: {},
      headers: new Headers({
        "Content-Type": "video/x-matroska",
        "Content-Range": "bytes 100-199/5000",
        "Content-Length": "100",
        "Accept-Ranges": "bytes",
      }),
    });
    const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
    const res = await GET(fakeReq({ search: "static=true" }), {
      params: Promise.resolve({ itemId: validId, path: ["stream.mkv"] }),
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 100-199/5000");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  it("returns 400 for a malformed itemId", async () => {
    const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
    const res = await GET(fakeReq(), { params: Promise.resolve({ itemId: "not-hex", path: ["x"] }) });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/jellyfin/stream/subtitle/[itemId]", () => {
  it("returns 400 when mediaSourceId or index is missing", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    const { GET } = await import("@/app/api/jellyfin/stream/subtitle/[itemId]/route");
    const res = await GET(fakeReq(), { params: Promise.resolve({ itemId: validId }) });
    expect(res.status).toBe(400);
  });

  it("returns the subtitle as text/vtt on success", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    global.fetch = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["WEBVTT"]) });
    const { GET } = await import("@/app/api/jellyfin/stream/subtitle/[itemId]/route");
    const res = await GET(fakeReq({ search: "mediaSourceId=src1&index=2" }), { params: Promise.resolve({ itemId: validId }) });
    expect(res.headers.get("content-type")).toBe("text/vtt");
  });
});
