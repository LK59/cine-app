import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({
  verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args),
}));

const mockWatchlistDb = {
  getAll: vi.fn(),
  get: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
  updateStatus: vi.fn(),
};
vi.mock("@/lib/db", () => ({
  watchlistDb: mockWatchlistDb,
}));

function fakeReq(opts: {
  cookie?: string;
  searchParams?: Record<string, string>;
  body?: unknown;
}): NextRequest {
  const params = new URLSearchParams(opts.searchParams ?? {});
  return {
    cookies: { get: (name: string) => (name === "cine_session" && opts.cookie ? { value: opts.cookie } : undefined) },
    nextUrl: { searchParams: params },
    json: async () => opts.body ?? null,
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/watchlist", () => {
  it("returns 401 when not authenticated", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    const { GET } = await import("@/app/api/watchlist/route");
    const res = await GET(fakeReq({}));
    expect(res.status).toBe(401);
  });

  it("returns the user's watchlist, using jfId when available", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-123", role: "admin" });
    mockWatchlistDb.getAll.mockReturnValue([{ id: 1, title: "Inception" }]);
    const { GET } = await import("@/app/api/watchlist/route");
    const res = await GET(fakeReq({ cookie: "sometoken" }));
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(mockWatchlistDb.getAll).toHaveBeenCalledWith("jf-123", undefined);
  });

  it("falls back to username when no jfId", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", role: "admin" });
    mockWatchlistDb.getAll.mockReturnValue([]);
    const { GET } = await import("@/app/api/watchlist/route");
    await GET(fakeReq({ cookie: "sometoken" }));
    expect(mockWatchlistDb.getAll).toHaveBeenCalledWith("louis", undefined);
  });

  it("passes the status filter through", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", role: "admin" });
    mockWatchlistDb.getAll.mockReturnValue([]);
    const { GET } = await import("@/app/api/watchlist/route");
    await GET(fakeReq({ cookie: "sometoken", searchParams: { status: "favorite" } }));
    expect(mockWatchlistDb.getAll).toHaveBeenCalledWith("louis", "favorite");
  });
});

describe("POST /api/watchlist", () => {
  it("returns 401 when not authenticated", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    const { POST } = await import("@/app/api/watchlist/route");
    const res = await POST(fakeReq({ body: {} }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when required fields are missing", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", role: "admin" });
    const { POST } = await import("@/app/api/watchlist/route");
    const res = await POST(fakeReq({ cookie: "t", body: { mediaType: "movie" } }));
    expect(res.status).toBe(400);
  });

  it("upserts with defaults for optional fields", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", role: "admin" });
    mockWatchlistDb.upsert.mockReturnValue({ id: 1, title: "Dune" });
    const { POST } = await import("@/app/api/watchlist/route");
    const res = await POST(fakeReq({ cookie: "t", body: { mediaType: "movie", tmdbId: 42, title: "Dune" } }));
    expect(res.status).toBe(200);
    expect(mockWatchlistDb.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "louis", mediaType: "movie", tmdbId: 42, title: "Dune", status: "to_watch", note: null })
    );
  });
});

describe("DELETE /api/watchlist", () => {
  it("returns 401 when not authenticated", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    const { DELETE } = await import("@/app/api/watchlist/route");
    const res = await DELETE(fakeReq({ body: {} }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when tmdbId/mediaType missing", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", role: "admin" });
    const { DELETE } = await import("@/app/api/watchlist/route");
    const res = await DELETE(fakeReq({ cookie: "t", body: {} }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when item does not exist", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", role: "admin" });
    mockWatchlistDb.get.mockReturnValue(null);
    const { DELETE } = await import("@/app/api/watchlist/route");
    const res = await DELETE(fakeReq({ cookie: "t", body: { tmdbId: 1, mediaType: "movie" } }));
    expect(res.status).toBe(404);
  });

  it("removes an existing item", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", role: "admin" });
    mockWatchlistDb.get.mockReturnValue({ id: 7 });
    mockWatchlistDb.remove.mockReturnValue(true);
    const { DELETE } = await import("@/app/api/watchlist/route");
    const res = await DELETE(fakeReq({ cookie: "t", body: { tmdbId: 1, mediaType: "movie" } }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockWatchlistDb.remove).toHaveBeenCalledWith("louis", 7);
  });
});

describe("PATCH /api/watchlist/item", () => {
  it("returns 401 when not authenticated", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    const { PATCH } = await import("@/app/api/watchlist/item/route");
    const res = await PATCH(fakeReq({ body: {} }));
    expect(res.status).toBe(401);
  });

  it("returns 404 when update finds no matching row", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", role: "admin" });
    mockWatchlistDb.updateStatus.mockReturnValue(false);
    const { PATCH } = await import("@/app/api/watchlist/item/route");
    const res = await PATCH(fakeReq({ cookie: "t", body: { id: 1, status: "watched" } }));
    expect(res.status).toBe(404);
  });

  it("updates status and note", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", role: "admin" });
    mockWatchlistDb.updateStatus.mockReturnValue(true);
    const { PATCH } = await import("@/app/api/watchlist/item/route");
    const res = await PATCH(fakeReq({ cookie: "t", body: { id: 1, status: "watched", note: "great" } }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockWatchlistDb.updateStatus).toHaveBeenCalledWith("louis", 1, "watched", "great");
  });
});

describe("GET /api/watchlist/item", () => {
  it("returns null item when params are missing", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", role: "admin" });
    const { GET } = await import("@/app/api/watchlist/item/route");
    const res = await GET(fakeReq({ cookie: "t" }));
    const body = await res.json();
    expect(body.item).toBeNull();
  });

  it("returns the item for valid params", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", role: "admin" });
    mockWatchlistDb.get.mockReturnValue({ id: 1, title: "Dune" });
    const { GET } = await import("@/app/api/watchlist/item/route");
    const res = await GET(fakeReq({ cookie: "t", searchParams: { mediaType: "movie", tmdbId: "42" } }));
    const body = await res.json();
    expect(body.item.title).toBe("Dune");
    expect(mockWatchlistDb.get).toHaveBeenCalledWith("louis", "movie", 42);
  });
});
