import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockRadarr = {
  addMovie: vi.fn(),
  lookupMovie: vi.fn(),
  getMovie: vi.fn(),
  updateMovie: vi.fn(),
  deleteMovie: vi.fn(),
  triggerSearch: vi.fn(),
  deleteMovieFile: vi.fn(),
};
vi.mock("@/lib/clients/radarr", () => ({ radarr: mockRadarr }));
const mockJellyseerr = { getMovieMedia: vi.fn(), deleteMedia: vi.fn() };
vi.mock("@/lib/clients/jellyseerr", () => ({ jellyseerr: mockJellyseerr }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
const mockCachedMovies = vi.fn();
const mockInvalidateLibrary = vi.fn();
vi.mock("@/lib/server-cache", () => ({
  cachedMovies: (...args: unknown[]) => mockCachedMovies(...args),
  invalidateLibrary: () => mockInvalidateLibrary(),
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

function fakeReq(opts: { params?: Record<string, string>; body?: unknown } = {}): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(opts.params ?? {}) },
    cookies: { get: () => undefined },
    json: async () => opts.body ?? null,
  } as unknown as NextRequest;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockRadarr.getMovie.mockResolvedValue({ id: 7, tmdbId: 99 });
  mockJellyseerr.getMovieMedia.mockResolvedValue({ mediaInfo: undefined });
});

describe("GET/POST /api/radarr/movies", () => {
  it("GET returns the cached movie list", async () => {
    mockCachedMovies.mockResolvedValue([{ id: 1 }]);
    const { GET } = await import("@/app/api/radarr/movies/route");
    const res = await GET();
    expect(await res.json()).toEqual([{ id: 1 }]);
  });

  it("POST forwards the request body to radarr.addMovie", async () => {
    mockRadarr.addMovie.mockResolvedValue({ id: 5 });
    const { POST } = await import("@/app/api/radarr/movies/route");
    const res = await POST(fakeReq({ body: { tmdbId: 42 } }));
    expect(mockRadarr.addMovie).toHaveBeenCalledWith({ tmdbId: 42 });
    expect(await res.json()).toEqual({ id: 5 });
  });
});

describe("GET /api/radarr/movies/lookup", () => {
  it("passes the 'term' query param through, defaulting to empty string", async () => {
    mockRadarr.lookupMovie.mockResolvedValue([]);
    const { GET } = await import("@/app/api/radarr/movies/lookup/route");
    await GET(fakeReq());
    expect(mockRadarr.lookupMovie).toHaveBeenCalledWith("");
    await GET(fakeReq({ params: { term: "dune" } }));
    expect(mockRadarr.lookupMovie).toHaveBeenCalledWith("dune");
  });
});

describe("/api/radarr/movies/[id]", () => {
  it("GET fetches the movie by numeric id", async () => {
    mockRadarr.getMovie.mockResolvedValue({ id: 7 });
    const { GET } = await import("@/app/api/radarr/movies/[id]/route");
    await GET(fakeReq(), params("7"));
    expect(mockRadarr.getMovie).toHaveBeenCalledWith(7);
  });

  it("PUT forwards the id and payload to radarr.updateMovie", async () => {
    mockRadarr.updateMovie.mockResolvedValue({ id: 7 });
    const { PUT } = await import("@/app/api/radarr/movies/[id]/route");
    await PUT(fakeReq({ body: { monitored: false } }), params("7"));
    expect(mockRadarr.updateMovie).toHaveBeenCalledWith(7, { monitored: false });
  });

  it("DELETE invalidates the library cache and returns ok:true on success", async () => {
    mockRadarr.deleteMovie.mockResolvedValue(undefined);
    const { DELETE } = await import("@/app/api/radarr/movies/[id]/route");
    const res = await DELETE(fakeReq(), params("7"));
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(mockInvalidateLibrary).toHaveBeenCalled();
  });

  it("DELETE returns 500 without invalidating the cache when Radarr fails", async () => {
    mockRadarr.deleteMovie.mockRejectedValue(new Error("fail"));
    const { DELETE } = await import("@/app/api/radarr/movies/[id]/route");
    const res = await DELETE(fakeReq(), params("7"));
    expect(res.status).toBe(500);
    expect(mockInvalidateLibrary).not.toHaveBeenCalled();
  });

  it("DELETE also clears the stale Jellyseerr media record for this title", async () => {
    mockRadarr.deleteMovie.mockResolvedValue(undefined);
    mockJellyseerr.getMovieMedia.mockResolvedValue({ mediaInfo: { id: 321, status: 5 } });
    const { DELETE } = await import("@/app/api/radarr/movies/[id]/route");
    const res = await DELETE(fakeReq(), params("7"));
    expect(mockJellyseerr.getMovieMedia).toHaveBeenCalledWith(99, undefined);
    expect(mockJellyseerr.deleteMedia).toHaveBeenCalledWith(321, undefined);
    expect((await res.json()).ok).toBe(true);
  });

  it("DELETE still succeeds even if the Jellyseerr cleanup fails", async () => {
    mockRadarr.deleteMovie.mockResolvedValue(undefined);
    mockJellyseerr.getMovieMedia.mockRejectedValue(new Error("Jellyseerr down"));
    const { DELETE } = await import("@/app/api/radarr/movies/[id]/route");
    const res = await DELETE(fakeReq(), params("7"));
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(mockInvalidateLibrary).toHaveBeenCalled();
  });
});

describe("POST /api/radarr/movies/[id]/search", () => {
  it("returns 400 for a non-numeric/zero id", async () => {
    const { POST } = await import("@/app/api/radarr/movies/[id]/search/route");
    const res = await POST(fakeReq(), params("0"));
    expect(res.status).toBe(400);
  });

  it("triggers a Radarr search for a valid id", async () => {
    mockRadarr.triggerSearch.mockResolvedValue({ ok: true });
    const { POST } = await import("@/app/api/radarr/movies/[id]/search/route");
    await POST(fakeReq(), params("7"));
    expect(mockRadarr.triggerSearch).toHaveBeenCalledWith(7);
  });
});

describe("DELETE /api/radarr/movies/[id]/file", () => {
  it("returns 404 when the movie has no associated file", async () => {
    mockRadarr.getMovie.mockResolvedValue({ movieFile: null });
    const { DELETE } = await import("@/app/api/radarr/movies/[id]/file/route");
    const res = await DELETE(fakeReq(), params("7"));
    expect(res.status).toBe(404);
    expect(mockRadarr.deleteMovieFile).not.toHaveBeenCalled();
  });

  it("deletes the file and invalidates the library cache", async () => {
    mockRadarr.getMovie.mockResolvedValue({ movieFile: { id: 99 } });
    const { DELETE } = await import("@/app/api/radarr/movies/[id]/file/route");
    const res = await DELETE(fakeReq(), params("7"));
    expect(mockRadarr.deleteMovieFile).toHaveBeenCalledWith(99);
    expect(mockInvalidateLibrary).toHaveBeenCalled();
    expect((await res.json()).ok).toBe(true);
  });
});
