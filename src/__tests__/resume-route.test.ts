import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import { jellyfinOnlyIdFor } from "@/lib/jellyfinOnlyId";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
const mockJellyfin = { getResumeItems: vi.fn(), getItemProviderIds: vi.fn(), resetPlaybackPosition: vi.fn() };
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: mockJellyfin }));
const mockCachedMovies = vi.fn();
const mockCachedSeries = vi.fn();
const mockJfMovies = vi.fn();
const mockJfSeries = vi.fn();
const mockEpisodeCount = vi.fn();
vi.mock("@/lib/server-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server-cache")>()),
  cachedMovies: (...args: unknown[]) => mockCachedMovies(...args),
  cachedSeries: (...args: unknown[]) => mockCachedSeries(...args),
  // Le lien vers la fiche vient du catalogue (le dossier, DECISIONS.md §89) : les listes de
  // Radarr/Sonarr et celles de Jellyfin, plus rien de ce que Jellyfin a posé sur l'élément.
  cachedJellyfinMoviesAdmin: () => mockJfMovies(),
  cachedJellyfinSeriesAdmin: () => mockJfSeries(),
  cachedJellyfinEpisodeCount: (id: string) => mockEpisodeCount(id),
  cachedItemProviderIds: (userId: unknown, itemId: unknown) => mockJellyfin.getItemProviderIds(userId, itemId),
}));

function fakeReq(cookie = "t"): NextRequest {
  return { cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) } } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCachedMovies.mockResolvedValue([]);
  mockCachedSeries.mockResolvedValue([]);
  mockJfMovies.mockResolvedValue([]);
  mockJfSeries.mockResolvedValue([]);
  mockEpisodeCount.mockResolvedValue(0);
});

describe("GET /api/jellyfin/resume", () => {
  it("returns empty items when there is no Jellyfin session", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    const { GET } = await import("@/app/api/jellyfin/resume/route");
    const res = await GET(fakeReq());
    const body = await res.json();
    expect(body.items).toEqual([]);
  });

  it("links a resumed movie to its Radarr sheet by its folder", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    mockJellyfin.getResumeItems.mockResolvedValue({
      Items: [{ Id: "m1", Type: "Movie", Name: "Dune", ProviderIds: { Tmdb: "42" }, RunTimeTicks: 100, UserData: { PlaybackPositionTicks: 50 } }],
    });
    mockCachedMovies.mockResolvedValue([{ tmdbId: 42, id: 7, hasFile: true, title: "Dune", path: "/movies/Dune (2021)" }]);
    mockJfMovies.mockResolvedValue([{ Id: "m1", Name: "Dune", ProviderIds: { Tmdb: "42" }, Path: "/media/movies/Dune (2021)/Dune.mkv" }]);

    const { GET } = await import("@/app/api/jellyfin/resume/route");
    const res = await GET(fakeReq());
    const body = await res.json();
    expect(body.items[0]).toMatchObject({ cinemaHref: "/radarr/7", progress: 50 });
  });

  // *Aliens* (14/10/2026) : Jellyfin avait posé le TMDB d'*Alien³* sur l'élément du dossier
  // « Aliens (1986) ». La carte ouvre la fiche du titre que Radarr range dans ce dossier.
  it("opens the film Radarr keeps in that folder, whatever Jellyfin's TMDB says", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    mockJellyfin.getResumeItems.mockResolvedValue({
      Items: [{ Id: "m1", Type: "Movie", Name: "Alien³", ProviderIds: { Tmdb: "8077" }, RunTimeTicks: 100, UserData: { PlaybackPositionTicks: 50 } }],
    });
    mockCachedMovies.mockResolvedValue([
      { tmdbId: 679, id: 7, hasFile: true, title: "Aliens", year: 1986, path: "/movies/Aliens (1986)" },
      { tmdbId: 8077, id: 9, hasFile: false, title: "Alien³", year: 1992, path: "/movies/Alien3 (1992)" },
    ]);
    mockJfMovies.mockResolvedValue([{ Id: "m1", Name: "Alien³", ProviderIds: { Tmdb: "8077" }, Path: "/media/movies/Aliens (1986)/Alien³.mkv" }]);
    const { GET } = await import("@/app/api/jellyfin/resume/route");
    const body = await (await GET(fakeReq())).json();
    expect(body.items[0].cinemaHref).toBe("/radarr/7");
  });

  // Un film dont Radarr n'a plus le fichier n'est pas dans le catalogue du cinéma : son lien menait
  // à une fiche introuvable, et le clic ne faisait rien. Sans lien, la carte lance la lecture.
  it("does not link a film Radarr has no file for", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    mockJellyfin.getResumeItems.mockResolvedValue({
      Items: [{ Id: "m1", Type: "Movie", Name: "Dune", ProviderIds: { Tmdb: "42" }, RunTimeTicks: 100, UserData: { PlaybackPositionTicks: 50 } }],
    });
    mockCachedMovies.mockResolvedValue([{ tmdbId: 42, id: 7, hasFile: false, title: "Dune", path: "/movies/Dune (2021)" }]);
    const { GET } = await import("@/app/api/jellyfin/resume/route");
    const body = await (await GET(fakeReq())).json();
    expect(body.items[0].cinemaHref).toBeNull();
  });

  // *Shōgun* (14/10/2026) : Jellyfin lisait le dossier comme la série de 1980 (un autre TVDB). La
  // carte d'un épisode ouvre la série que Sonarr range dans ce dossier — sans rien redemander à
  // Jellyfin sur la série.
  it("links an episode to the series Sonarr keeps in its folder, without asking Jellyfin for ids", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    mockJellyfin.getResumeItems.mockResolvedValue({
      Items: [{
        Id: "e1", Type: "Episode", Name: "Anjin", SeriesId: "series-1", SeriesName: "Shōgun",
        ParentIndexNumber: 1, IndexNumber: 3, RunTimeTicks: 100, UserData: { PlaybackPositionTicks: 10 },
      }],
    });
    mockCachedSeries.mockResolvedValue([{ tvdbId: 392573, id: 22, title: "Shōgun", year: 2024, path: "/tv/Shōgun", statistics: { episodeFileCount: 10 } }]);
    mockJfSeries.mockResolvedValue([{ Id: "series-1", Name: "Shōgun", ProviderIds: { Tvdb: "80284" }, Path: "/media/tv/Shōgun" }]);

    const { GET } = await import("@/app/api/jellyfin/resume/route");
    const body = await (await GET(fakeReq())).json();
    expect(mockJellyfin.getItemProviderIds).not.toHaveBeenCalled();
    expect(body.items[0]).toMatchObject({ cinemaHref: "/sonarr/22", name: "Shōgun", subtitle: "S01E03 · Anjin" });
  });

  // *La casa de papel* : une série que Jellyfin a seule a sa fiche (identifiant réservé, §89).
  it("links an episode of a series Jellyfin has alone to its reserved sheet", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    mockJellyfin.getResumeItems.mockResolvedValue({
      Items: [{ Id: "e1", Type: "Episode", Name: "Épisode 1", SeriesId: "lcdp", SeriesName: "La casa de papel", RunTimeTicks: 1, UserData: {} }],
    });
    mockJfSeries.mockResolvedValue([{ Id: "lcdp", Name: "La casa de papel", ProviderIds: { Tmdb: "71446" }, Path: "/media/tv/La Casa de Papel" }]);
    mockEpisodeCount.mockResolvedValue(48);
    const { GET } = await import("@/app/api/jellyfin/resume/route");
    const body = await (await GET(fakeReq())).json();
    expect(body.items[0].cinemaHref).toBe(`/sonarr/${jellyfinOnlyIdFor("lcdp")}`);
  });

  it("caps progress at 99% even when position exceeds runtime", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    mockJellyfin.getResumeItems.mockResolvedValue({
      Items: [{ Id: "m1", Type: "Movie", Name: "X", RunTimeTicks: 100, UserData: { PlaybackPositionTicks: 500 } }],
    });
    const { GET } = await import("@/app/api/jellyfin/resume/route");
    const res = await GET(fakeReq());
    const body = await res.json();
    expect(body.items[0].progress).toBe(99);
  });

  it("leaves cinemaHref null when nothing in the resume item matches the library", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    mockJellyfin.getResumeItems.mockResolvedValue({
      Items: [{ Id: "m1", Type: "Movie", Name: "X", ProviderIds: { Tmdb: "1" }, RunTimeTicks: 1, UserData: {} }],
    });
    mockCachedMovies.mockResolvedValue([]);
    const { GET } = await import("@/app/api/jellyfin/resume/route");
    const res = await GET(fakeReq());
    const body = await res.json();
    expect(body.items[0].cinemaHref).toBeNull();
  });
});

/**
 * Retirer un titre de « Reprendre » (23/09/2026) : la position seule est oubliée — pas l'état
 * « Vu » ni le nombre de visionnages, que `markUnplayed` aurait effacés — et seulement sur le
 * compte de la session.
 */
describe("DELETE /api/jellyfin/resume", () => {
  const ITEM = "a".repeat(32);
  const del = async (body: unknown, cookie = "t") => {
    const { DELETE } = await import("@/app/api/jellyfin/resume/route");
    const req = { ...fakeReq(cookie), json: async () => body } as unknown as NextRequest;
    return DELETE(req);
  };

  it("oublie la position, sur le compte de la session", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    mockJellyfin.resetPlaybackPosition.mockResolvedValue({});
    const res = await del({ itemId: ITEM });
    expect(res.status).toBe(200);
    expect(mockJellyfin.resetPlaybackPosition).toHaveBeenCalledWith("jf-1", ITEM);
  });

  it("refuse sans compte Jellyfin", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    expect((await del({ itemId: ITEM })).status).toBe(403);
    expect(mockJellyfin.resetPlaybackPosition).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ itemId: "../x" }], [{ itemId: 42 }], [null]])("refuse un identifiant invalide (%j)", async (body) => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    expect((await del(body)).status).toBe(400);
    expect(mockJellyfin.resetPlaybackPosition).not.toHaveBeenCalled();
  });

  it("dit l'échec de Jellyfin au lieu de le taire", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    mockJellyfin.resetPlaybackPosition.mockRejectedValue(new Error("Jellyfin injoignable"));
    expect((await del({ itemId: ITEM })).status).toBe(502);
  });
});

// Une panne n'est pas une liste vide (DECISIONS.md §92) : `{ items: [] }` se lisait « rien à
// reprendre » et remplaçait la rangée gardée sur l'appareil. Un 502 nommé laisse au client ce qu'il
// tenait — SWR garde sa donnée quand une relecture échoue.
describe("GET /api/jellyfin/resume pendant une panne de Jellyfin", () => {
  it("répond 502 upstream_unreachable, jamais une liste vide", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    const { UpstreamUnreachableError } = await import("@/lib/http");
    mockJellyfin.getResumeItems.mockRejectedValue(new UpstreamUnreachableError("jellyfin ne répond pas (ENOTFOUND)", "ENOTFOUND", "jellyfin"));
    const { GET } = await import("@/app/api/jellyfin/resume/route");
    const res = await GET(fakeReq());
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body).toMatchObject({ code: "upstream_unreachable" });
    expect(body.items).toBeUndefined();
  });
});
