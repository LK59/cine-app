import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
const mockWatchlistDb = { getBulkStatus: vi.fn() };
vi.mock("@/lib/db", () => ({ watchlistDb: mockWatchlistDb }));

function fakeReq(items?: string, cookie = "t"): NextRequest {
  return {
    cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) },
    nextUrl: { searchParams: new URLSearchParams(items ? { items } : {}) },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/watchlist/bulk-status", () => {
  it("returns an empty object when there is no session", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    const { GET } = await import("@/app/api/watchlist/bulk-status/route");
    const res = await GET(fakeReq("movie:1"));
    const body = await res.json();
    expect(body).toEqual({});
    expect(mockWatchlistDb.getBulkStatus).not.toHaveBeenCalled();
  });

  it("returns an empty object when items is missing", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    const { GET } = await import("@/app/api/watchlist/bulk-status/route");
    const res = await GET(fakeReq());
    const body = await res.json();
    expect(body).toEqual({});
  });

  it("filters out malformed entries (bad mediaType or non-numeric id)", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    mockWatchlistDb.getBulkStatus.mockReturnValue(new Map());
    const { GET } = await import("@/app/api/watchlist/bulk-status/route");
    await GET(fakeReq("movie:123,bogus:456,series:abc,series:789"));
    expect(mockWatchlistDb.getBulkStatus).toHaveBeenCalledWith("louis", [
      { mediaType: "movie", tmdbId: 123 },
      { mediaType: "series", tmdbId: 789 },
    ]);
  });

  it("maps each requested key to its status, defaulting to null", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    mockWatchlistDb.getBulkStatus.mockReturnValue(new Map([["movie:123", "favorite"]]));
    const { GET } = await import("@/app/api/watchlist/bulk-status/route");
    const res = await GET(fakeReq("movie:123,series:456"));
    const body = await res.json();
    expect(body).toEqual({ "movie:123": "favorite", "series:456": null });
  });

  it("prefers jfId over username as the userId key", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    mockWatchlistDb.getBulkStatus.mockReturnValue(new Map());
    const { GET } = await import("@/app/api/watchlist/bulk-status/route");
    await GET(fakeReq("movie:1"));
    expect(mockWatchlistDb.getBulkStatus).toHaveBeenCalledWith("jf-1", expect.any(Array));
  });
});
