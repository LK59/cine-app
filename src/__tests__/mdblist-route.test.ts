import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

let rateLimitAllows = true;
vi.mock("@/lib/rateLimiter", () => ({
  createRateLimiter: () => () => rateLimitAllows,
}));
vi.mock("@/lib/api-helpers", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/server-cache", () => ({
  withCache: async (_key: string, _ttl: number, fn: () => unknown) => fn(),
}));

function fakeReq(): NextRequest {
  return {} as unknown as NextRequest;
}

const originalFetch = global.fetch;
const originalKey = process.env.MDBLIST_API_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitAllows = true;
  process.env.MDBLIST_API_KEY = "test-key";
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env.MDBLIST_API_KEY = originalKey;
});

describe("GET /api/mdblist/[imdbId]", () => {
  it("returns 429 when the rate limiter rejects the IP", async () => {
    rateLimitAllows = false;
    const { GET } = await import("@/app/api/mdblist/[imdbId]/route");
    const res = await GET(fakeReq(), { params: Promise.resolve({ imdbId: "tt1234567" }) });
    expect(res.status).toBe(429);
  });

  it("returns 400 for a malformed imdb id", async () => {
    const { GET } = await import("@/app/api/mdblist/[imdbId]/route");
    const res = await GET(fakeReq(), { params: Promise.resolve({ imdbId: "not-an-id" }) });
    expect(res.status).toBe(400);
  });

  it("returns null ratings without calling fetch when no API key is configured", async () => {
    delete process.env.MDBLIST_API_KEY;
    global.fetch = vi.fn();
    const { GET } = await import("@/app/api/mdblist/[imdbId]/route");
    const res = await GET(fakeReq(), { params: Promise.resolve({ imdbId: "tt1234567" }) });
    const body = await res.json();
    expect(body.ratings).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("maps mdblist source scores onto the ratings shape", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ratings: [
          { source: "imdb", score: 82 },
          { source: "tomatoes", score: 90 },
          { source: "metacritic", score: 70 },
        ],
      }),
    });
    const { GET } = await import("@/app/api/mdblist/[imdbId]/route");
    const res = await GET(fakeReq(), { params: Promise.resolve({ imdbId: "tt1234567" }) });
    const body = await res.json();
    expect(body.ratings).toMatchObject({ imdb: 82, tomatoes: 90, metacritic: 70, letterboxd: null });
  });

  it("returns null ratings (not a 500) when the upstream call fails", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    const { GET } = await import("@/app/api/mdblist/[imdbId]/route");
    const res = await GET(fakeReq(), { params: Promise.resolve({ imdbId: "tt1234567" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ratings).toBeNull();
  });

  it("returns null ratings when mdblist responds with a non-ok status", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const { GET } = await import("@/app/api/mdblist/[imdbId]/route");
    const res = await GET(fakeReq(), { params: Promise.resolve({ imdbId: "tt1234567" }) });
    const body = await res.json();
    expect(body.ratings).toBeNull();
  });
});
