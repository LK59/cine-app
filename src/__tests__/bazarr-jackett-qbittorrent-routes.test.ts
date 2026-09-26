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

const HASH = "0123456789abcdef0123456789abcdef01234567";

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
    const body = await (await GET(fakeReq())).json();
    expect(body).toEqual({ movies: [{ id: 1 }], episodes: [{ id: 2 }] });
    expect(mockBazarr.getWantedMovies).toHaveBeenCalledWith(25);
    expect(mockBazarr.getWantedEpisodes).toHaveBeenCalledWith(25);
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

describe("POST /api/jackett/indexers/[id]/test — identifiant validé (26/09/2026)", () => {
  it("refuse un identifiant qui sortirait du chemin de l'indexeur, sans appeler Jackett", async () => {
    const { POST } = await import("@/app/api/jackett/indexers/[id]/test/route");
    for (const id of ["../../server/config", "x?t=search&q=a", "a/b", ""]) {
      const res = await POST(fakeReq(), { params: Promise.resolve({ id }) });
      expect(res.status).toBe(400);
    }
    expect(mockJackett.testIndexer).not.toHaveBeenCalled();
  });

  it("accepte les identifiants réels", async () => {
    mockJackett.testIndexer.mockResolvedValue(true);
    const { POST } = await import("@/app/api/jackett/indexers/[id]/test/route");
    for (const id of ["yggreborn-api", "torrent9", "crazyspirits-api", "u2p"]) {
      expect((await POST(fakeReq(), { params: Promise.resolve({ id }) })).status).toBe(200);
    }
  });
});

describe("/api/qbittorrent/torrents/[hash] — empreinte validée (26/09/2026)", () => {
  it("refuse `all`, les listes et le reste, sans rien envoyer à qBittorrent", async () => {
    const { POST, DELETE } = await import("@/app/api/qbittorrent/torrents/[hash]/route");
    for (const hash of ["all", `${HASH}|${HASH}`, "abc", HASH + "0"]) {
      expect((await DELETE(fakeReq({ params: { deleteFiles: "true" } }), { params: Promise.resolve({ hash }) })).status).toBe(400);
      expect((await POST(fakeReq({ body: { action: "pause" } }), { params: Promise.resolve({ hash }) })).status).toBe(400);
    }
    expect(mockQbittorrent.remove).not.toHaveBeenCalled();
    expect(mockQbittorrent.pause).not.toHaveBeenCalled();
  });

  it("accepte une empreinte v2 de 64 caractères", async () => {
    mockQbittorrent.remove.mockResolvedValue("");
    const { DELETE } = await import("@/app/api/qbittorrent/torrents/[hash]/route");
    const v2 = HASH + "0123456789abcdef01234567".slice(0, 24);
    expect((await DELETE(fakeReq(), { params: Promise.resolve({ hash: v2 }) })).status).toBe(200);
  });

  it("répond 400, pas 500, à un corps illisible", async () => {
    const { POST } = await import("@/app/api/qbittorrent/torrents/[hash]/route");
    const req = { json: async () => { throw new SyntaxError("bad"); } } as unknown as NextRequest;
    expect((await POST(req, { params: Promise.resolve({ hash: HASH }) })).status).toBe(400);
  });
});

describe("POST /api/qbittorrent/torrents/[hash]", () => {
  it("pauses the torrent for action=pause", async () => {
    mockQbittorrent.pause.mockResolvedValue(undefined);
    const { POST } = await import("@/app/api/qbittorrent/torrents/[hash]/route");
    await POST(fakeReq({ body: { action: "pause" } }), { params: Promise.resolve({ hash: HASH }) });
    expect(mockQbittorrent.pause).toHaveBeenCalledWith([HASH]);
  });

  it("resumes the torrent for action=resume", async () => {
    mockQbittorrent.resume.mockResolvedValue(undefined);
    const { POST } = await import("@/app/api/qbittorrent/torrents/[hash]/route");
    await POST(fakeReq({ body: { action: "resume" } }), { params: Promise.resolve({ hash: HASH }) });
    expect(mockQbittorrent.resume).toHaveBeenCalledWith([HASH]);
  });

  it("returns 400 for an unknown action", async () => {
    const { POST } = await import("@/app/api/qbittorrent/torrents/[hash]/route");
    const res = await POST(fakeReq({ body: { action: "explode" } }), { params: Promise.resolve({ hash: HASH }) });
    expect(res.status).toBe(400);
  });

  it("DELETE forwards deleteFiles=true from the query string", async () => {
    mockQbittorrent.remove.mockResolvedValue(undefined);
    const { DELETE } = await import("@/app/api/qbittorrent/torrents/[hash]/route");
    await DELETE(fakeReq({ params: { deleteFiles: "true" } }), { params: Promise.resolve({ hash: HASH }) });
    expect(mockQbittorrent.remove).toHaveBeenCalledWith([HASH], true);
  });

  it("DELETE defaults deleteFiles to false", async () => {
    mockQbittorrent.remove.mockResolvedValue(undefined);
    const { DELETE } = await import("@/app/api/qbittorrent/torrents/[hash]/route");
    await DELETE(fakeReq(), { params: Promise.resolve({ hash: HASH }) });
    expect(mockQbittorrent.remove).toHaveBeenCalledWith([HASH], false);
  });
});
