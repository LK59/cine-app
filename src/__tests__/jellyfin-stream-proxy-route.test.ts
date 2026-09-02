import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (..._args: unknown[]) => mockVerifySessionFull(..._args) }));
vi.mock("@/lib/config", () => ({
  config: { player: { enabled: true }, jellyfin: { url: "http://jf.test", apiKey: "key" } },
}));

const mockFetch = vi.fn();
const validId = "b".repeat(32);

function fakeReq(url = `http://app/api/jellyfin/stream/${validId}/hls1/main/0.mp4`): NextRequest {
  const parsed = new URL(url);
  return {
    cookies: { get: (name: string) => (name === "cine_session" ? { value: "t" } : undefined) },
    headers: { get: () => null },
    nextUrl: { search: parsed.search, searchParams: parsed.searchParams },
    signal: new AbortController().signal,
  } as unknown as NextRequest;
}

function upstream(status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: new ReadableStream({ start: (c) => c.close() }),
    headers: { get: () => null },
    text: async () => "",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
  mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
});

async function get(path: string[] = ["hls1", "main", "0.mp4"]) {
  const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
  return GET(fakeReq(), { params: Promise.resolve({ itemId: validId, path }) });
}

describe("GET /api/jellyfin/stream/[itemId]/[...path]", () => {
  it("passes a successful segment straight through", async () => {
    mockFetch.mockResolvedValue(upstream(200));
    const res = await get();
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  // The race this retry exists for: right after a fresh transcode starts, the very first segment
  // can beat ffmpeg's own disk writes and come back 500. Safari gives up on one such failure.
  it("retries a transient 5xx from Jellyfin", async () => {
    mockFetch.mockResolvedValueOnce(upstream(500)).mockResolvedValueOnce(upstream(200));
    const res = await get();
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // A 4xx is a definite answer — a segment past the end of a finished transcode after a seek, a
  // stale session. Retrying it used to cost 1.7s of sleeps before telling the browser.
  it("does not retry a 4xx", async () => {
    mockFetch.mockResolvedValue(upstream(404));
    const res = await get();
    expect(res.status).toBe(404);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("gives up after exhausting the retry budget on a persistent 5xx", async () => {
    mockFetch.mockResolvedValue(upstream(503));
    const res = await get();
    expect(res.status).toBe(503);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("refuses a malformed item id and an unauthenticated caller", async () => {
    const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
    const bad = await GET(fakeReq(), { params: Promise.resolve({ itemId: "nope", path: ["x"] }) });
    expect(bad.status).toBe(400);

    mockVerifySessionFull.mockResolvedValue(null);
    const anon = await get();
    expect(anon.status).toBe(403);
  });
});
