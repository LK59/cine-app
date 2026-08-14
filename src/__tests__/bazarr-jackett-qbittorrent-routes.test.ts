import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockBazarr = {
  searchEpisodeSubtitles: vi.fn(),
  downloadEpisodeSubtitle: vi.fn(),
  searchMovieSubtitles: vi.fn(),
  downloadMovieSubtitle: vi.fn(),
  getProviders: vi.fn(),
  getWantedMovies: vi.fn(),
  getWantedEpisodes: vi.fn(),
};
vi.mock("@/lib/clients/bazarr", () => ({ bazarr: mockBazarr }));
const mockJackett = { getIndexers: vi.fn(), testIndexer: vi.fn() };
vi.mock("@/lib/clients/jackett", () => ({ jackett: mockJackett }));
const mockQbittorrent = { getTorrents: vi.fn(), pause: vi.fn(), resume: vi.fn(), remove: vi.fn(), getTransferInfo: vi.fn() };
vi.mock("@/lib/clients/qbittorrent", () => ({ qbittorrent: mockQbittorrent }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

function fakeReq(opts: { params?: Record<string, string>; body?: unknown } = {}): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(opts.params ?? {}) },
    json: async () => opts.body ?? null,
  } as unknown as NextRequest;
}

beforeEach(() => vi.clearAllMocks());

describe("/api/bazarr/episodes/[id]/subtitles", () => {
  it("GET searches subtitles for the numeric episode id", async () => {
    mockBazarr.searchEpisodeSubtitles.mockResolvedValue([]);
    const { GET } = await import("@/app/api/bazarr/episodes/[id]/subtitles/route");
    await GET(fakeReq(), { params: Promise.resolve({ id: "5" }) });
    expect(mockBazarr.searchEpisodeSubtitles).toHaveBeenCalledWith(5);
  });

  it("POST surfaces Bazarr's upstream error status and body text", async () => {
    mockBazarr.downloadEpisodeSubtitle.mockResolvedValue({ ok: false, status: 422, text: async () => "bad candidate" });
    const { POST } = await import("@/app/api/bazarr/episodes/[id]/subtitles/route");
    const res = await POST(fakeReq({ body: { seriesId: 1, candidate: {} } }), { params: Promise.resolve({ id: "5" }) });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("bad candidate");
  });

  it("POST returns ok:true on a successful download", async () => {
    mockBazarr.downloadEpisodeSubtitle.mockResolvedValue({ ok: true });
    const { POST } = await import("@/app/api/bazarr/episodes/[id]/subtitles/route");
    const res = await POST(fakeReq({ body: { seriesId: 1, candidate: {} } }), { params: Promise.resolve({ id: "5" }) });
    expect((await res.json()).ok).toBe(true);
  });
});

describe("/api/bazarr/movies/[id]/subtitles", () => {
  it("POST surfaces Bazarr's upstream error", async () => {
    mockBazarr.downloadMovieSubtitle.mockResolvedValue({ ok: false, status: 500, text: async () => "" });
    const { POST } = await import("@/app/api/bazarr/movies/[id]/subtitles/route");
    const res = await POST(fakeReq({ body: { candidate: {} } }), { params: Promise.resolve({ id: "5" }) });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Échec (500)");
  });
});

describe("GET /api/bazarr/wanted", () => {
  it("combines wanted movies and episodes into one payload", async () => {
    mockBazarr.getWantedMovies.mockResolvedValue([{ id: 1 }]);
    mockBazarr.getWantedEpisodes.mockResolvedValue([{ id: 2 }]);
    const { GET } = await import("@/app/api/bazarr/wanted/route");
    const body = await (await GET()).json();
    expect(body).toEqual({ movies: [{ id: 1 }], episodes: [{ id: 2 }] });
  });
});

describe("POST /api/jackett/indexers/[id]/test", () => {
  it("returns the boolean result from jackett.testIndexer", async () => {
    mockJackett.testIndexer.mockResolvedValue(true);
    const { POST } = await import("@/app/api/jackett/indexers/[id]/test/route");
    const res = await POST(fakeReq(), { params: Promise.resolve({ id: "idx-1" }) });
    expect(await res.json()).toEqual({ ok: true });
    expect(mockJackett.testIndexer).toHaveBeenCalledWith("idx-1");
  });
});

describe("POST /api/qbittorrent/torrents/[hash]", () => {
  it("pauses the torrent for action=pause", async () => {
    mockQbittorrent.pause.mockResolvedValue(undefined);
    const { POST } = await import("@/app/api/qbittorrent/torrents/[hash]/route");
    await POST(fakeReq({ body: { action: "pause" } }), { params: Promise.resolve({ hash: "abc" }) });
    expect(mockQbittorrent.pause).toHaveBeenCalledWith(["abc"]);
  });

  it("resumes the torrent for action=resume", async () => {
    mockQbittorrent.resume.mockResolvedValue(undefined);
    const { POST } = await import("@/app/api/qbittorrent/torrents/[hash]/route");
    await POST(fakeReq({ body: { action: "resume" } }), { params: Promise.resolve({ hash: "abc" }) });
    expect(mockQbittorrent.resume).toHaveBeenCalledWith(["abc"]);
  });

  it("returns 400 for an unknown action", async () => {
    const { POST } = await import("@/app/api/qbittorrent/torrents/[hash]/route");
    const res = await POST(fakeReq({ body: { action: "explode" } }), { params: Promise.resolve({ hash: "abc" }) });
    expect(res.status).toBe(400);
  });

  it("DELETE forwards deleteFiles=true from the query string", async () => {
    mockQbittorrent.remove.mockResolvedValue(undefined);
    const { DELETE } = await import("@/app/api/qbittorrent/torrents/[hash]/route");
    await DELETE(fakeReq({ params: { deleteFiles: "true" } }), { params: Promise.resolve({ hash: "abc" }) });
    expect(mockQbittorrent.remove).toHaveBeenCalledWith(["abc"], true);
  });

  it("DELETE defaults deleteFiles to false", async () => {
    mockQbittorrent.remove.mockResolvedValue(undefined);
    const { DELETE } = await import("@/app/api/qbittorrent/torrents/[hash]/route");
    await DELETE(fakeReq(), { params: Promise.resolve({ hash: "abc" }) });
    expect(mockQbittorrent.remove).toHaveBeenCalledWith(["abc"], false);
  });
});
