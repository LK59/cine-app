import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * La route du catalogue des séries applique §75 : la date d'une série est celle de son dernier
 * épisode quand ce compte ne l'a pas vu, pour une requête de bibliothèque et une requête de compte,
 * quel que soit le nombre de séries.
 */

const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

const mockSeries = vi.fn();
const mockJfSeries = vi.fn();
const mockRecent = vi.fn();
const mockPlayedAmong = vi.fn();
const mockAccount = vi.fn();

vi.mock("@/lib/server-cache", () => ({
  cachedSeries: () => mockSeries(),
  cachedJellyfinSeriesAdmin: () => mockJfSeries(),
  cachedJellyfinFirstEpisodes: async () => [],
  cachedJellyfinSeasons: async () => [],
  cachedJellyfinRecentEpisodes: () => mockRecent(),
  cachedJellyfinPlayedAmong: (...a: unknown[]) => mockPlayedAmong(...a),
  findJellyfinSeriesByTvdb: (items: { Id: string; ProviderIds?: { Tvdb?: string } }[], tvdbId: number) =>
    items.find((i) => i.ProviderIds?.Tvdb === String(tvdbId)) ?? null,
}));

vi.mock("@/lib/blockedTags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/blockedTags")>()),
  hiddenForRequest: async () => ({ hidden: new Set<number>(), signature: "", jfId: mockAccount() }),
}));

vi.mock("@/lib/title-art", () => ({
  getTitleArt: async () => ({ posterByLang: {}, posterTextlessUrl: null }),
  logoForLocale: () => null,
  logoForScreen: () => null,
}));

vi.mock("@/lib/imdb-rating", () => ({ getImdbRating: async () => null }));

const jfId = (n: number) => String(n).padStart(32, "a");

function sonarrSeries(id: number, addedDaysAgo: number) {
  return { id, title: `Série ${id}`, year: 2020, tvdbId: 1000 + id, tmdbId: null, images: [], genres: ["Drame"], added: iso(addedDaysAgo), path: null, statistics: { episodeFileCount: 10 } };
}

function library(count: number) {
  // `count` séries anciennes ; la série 1 reçoit un épisode aujourd'hui, la série 2 ouvre sa saison 2.
  mockSeries.mockResolvedValue(Array.from({ length: count }, (_, i) => sonarrSeries(i + 1, 200)));
  mockJfSeries.mockResolvedValue(Array.from({ length: count }, (_, i) => ({ Id: jfId(i + 1), ProviderIds: { Tvdb: String(1001 + i) }, DateCreated: iso(200) })));
  mockRecent.mockResolvedValue([
    { id: "ep-1-latest", seriesId: jfId(1), season: 4, episode: 10, createdAt: iso(0) },
    { id: "ep-2-s2e1", seriesId: jfId(2), season: 2, episode: 1, createdAt: iso(1) },
  ]);
}

const req = () => new Request("https://cine.example/api/cinema/series");

beforeEach(() => {
  vi.clearAllMocks();
  mockAccount.mockReturnValue("c".repeat(32));
});

describe("GET /api/cinema/series — §75", () => {
  it("une série ancienne qui reçoit un épisode remonte en tête, avec ce que dit sa pastille", async () => {
    library(5);
    mockPlayedAmong.mockResolvedValue(new Set());
    const { GET } = await import("@/app/api/cinema/series/route");
    const body = await (await GET(req())).json();
    expect(body.recentlyAdded.slice(0, 2)).toEqual([1, 2]);
    expect(body.spotlight.slice(0, 2)).toEqual([1, 2]);
    const byId = new Map(body.items.map((i: { sonarrId: number }) => [i.sonarrId, i]));
    expect(byId.get(1)).toMatchObject({ arrival: "episode" });
    expect(byId.get(2)).toMatchObject({ arrival: "season" });
    expect(byId.get(3)).not.toHaveProperty("arrival");
  });

  it("un épisode que le compte a déjà vu ne fait pas remonter sa série", async () => {
    library(5);
    mockPlayedAmong.mockResolvedValue(new Set(["ep-1-latest"]));
    const { GET } = await import("@/app/api/cinema/series/route");
    const body = await (await GET(req())).json();
    const ted = body.items.find((i: { sonarrId: number }) => i.sonarrId === 1);
    expect(ted).not.toHaveProperty("arrival");
    expect(Date.now() - Date.parse(ted.addedAt)).toBeGreaterThan(100 * DAY);
    expect(body.recentlyAdded[0]).toBe(2);
  });

  it("le coût ne dépend pas du nombre de séries : une lecture de bibliothèque, un appel pour le compte", async () => {
    library(300);
    mockPlayedAmong.mockResolvedValue(new Set());
    const { GET } = await import("@/app/api/cinema/series/route");
    await GET(req());
    expect(mockRecent).toHaveBeenCalledTimes(1);
    expect(mockPlayedAmong).toHaveBeenCalledTimes(1);
    // Seuls les derniers épisodes des séries qui en ont reçu un sont demandés.
    expect(mockPlayedAmong.mock.calls[0][1]).toEqual(["ep-1-latest", "ep-2-s2e1"]);
  });

  it("un Jellyfin qui ne dit pas ce qui est vu laisse remonter, sans faire tomber le catalogue", async () => {
    library(3);
    mockPlayedAmong.mockRejectedValue(new Error("Jellyfin injoignable"));
    const { GET } = await import("@/app/api/cinema/series/route");
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).recentlyAdded[0]).toBe(1);
  });
});
