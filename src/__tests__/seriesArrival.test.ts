import { describe, it, expect, vi, afterEach } from "vitest";
import { latestArrivals, seriesFreshness, type RecentEpisode } from "@/lib/seriesArrival";
import { newBadgeKey, recentlyAddedRail, NEW_BADGE_DAYS } from "@/lib/cinemaRails";
import { jellyfin } from "@/lib/clients/jellyfin";

/**
 * DECISIONS.md §74 — une série date de ce qu'on peut y regarder de plus récent, et sa pastille dit
 * pourquoi. Le 12/10/2026, *Ted Lasso* (ajoutée en avril) recevait sa saison 4 sans jamais remonter.
 */

const NOW = Date.parse("2026-10-12T12:00:00Z");
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const ep = (id: string, seriesId: string, season: number, episode: number, daysAgo: number): RecentEpisode => ({
  id,
  seriesId,
  season,
  episode,
  createdAt: iso(daysAgo),
});

describe("latestArrivals — le dernier ajout de chaque série", () => {
  it("prend l'épisode le plus récent, et un épisode hebdomadaire n'ouvre pas de saison", () => {
    const map = latestArrivals([ep("e9", "ted", 4, 9, 7), ep("e10", "ted", 4, 10, 0)]);
    expect(map.get("ted")).toEqual({ episodeId: "e10", at: iso(0), opensSeason: false });
  });

  it("l'épisode 1 d'une saison au-delà de la première ouvre une saison", () => {
    expect(latestArrivals([ep("s2e1", "x", 2, 1, 1)]).get("x")?.opensSeason).toBe(true);
  });

  it("plusieurs épisodes d'une saison dont on n'avait rien ouvrent une saison, même sans l'épisode 1", () => {
    const map = latestArrivals([ep("a", "x", 3, 2, 1), ep("b", "x", 3, 3, 1.01)]);
    expect(map.get("x")?.opensSeason).toBe(true);
  });

  it("un épisode de la même saison arrivé avant le lot : la saison n'est plus nouvelle", () => {
    const map = latestArrivals([ep("a", "x", 3, 1, 8), ep("b", "x", 3, 2, 1), ep("c", "x", 3, 3, 1)]);
    expect(map.get("x")?.opensSeason).toBe(false);
  });

  it("la saison 1 et les spéciaux n'ouvrent jamais de saison", () => {
    expect(latestArrivals([ep("a", "x", 1, 1, 0), ep("b", "x", 1, 2, 0)]).get("x")?.opensSeason).toBe(false);
    expect(latestArrivals([ep("a", "y", 0, 1, 0)]).get("y")?.opensSeason).toBe(false);
  });
});

describe("seriesFreshness — la date et la pastille d'une série pour un compte", () => {
  const old = iso(200);

  it("série ancienne + épisode récent non vu : remonte, « Nouvel épisode »", () => {
    const latest = { episodeId: "e10", at: iso(0), opensSeason: false };
    expect(seriesFreshness({ sonarrAddedAt: old, libraryAddedAt: old, latest, seenLatest: false, now: NOW })).toEqual({ addedAt: iso(0), arrival: "episode" });
  });

  it("E01 d'une nouvelle saison : « Nouvelle saison »", () => {
    const latest = { episodeId: "s2e1", at: iso(2), opensSeason: true };
    expect(seriesFreshness({ sonarrAddedAt: old, libraryAddedAt: old, latest, seenLatest: false, now: NOW })).toEqual({ addedAt: iso(2), arrival: "season" });
  });

  it("série récente : « Nouvelle série », datée de son dernier épisode s'il est plus tardif", () => {
    expect(seriesFreshness({ sonarrAddedAt: iso(3), libraryAddedAt: iso(3), latest: undefined, seenLatest: false, now: NOW })).toEqual({ addedAt: iso(3), arrival: "series" });
    const latest = { episodeId: "e2", at: iso(1), opensSeason: false };
    expect(seriesFreshness({ sonarrAddedAt: iso(3), libraryAddedAt: iso(3), latest, seenLatest: false, now: NOW })).toEqual({ addedAt: iso(1), arrival: "series" });
  });

  it("une série demandée il y a un an dont les premiers fichiers arrivent : « Nouvelle série »", () => {
    expect(seriesFreshness({ sonarrAddedAt: old, libraryAddedAt: iso(1), latest: undefined, seenLatest: false, now: NOW })).toEqual({ addedAt: iso(1), arrival: "series" });
  });

  it("épisode récent déjà vu par le compte : ne remonte pas", () => {
    const latest = { episodeId: "e10", at: iso(0), opensSeason: false };
    const r = seriesFreshness({ sonarrAddedAt: old, libraryAddedAt: old, latest, seenLatest: true, now: NOW });
    expect(r).toEqual({ addedAt: old });
    expect(newBadgeKey(r.addedAt, r.arrival, NOW)).toBeNull();
  });

  it("série jamais commencée : rien n'est vu, elle remonte", () => {
    const latest = { episodeId: "e10", at: iso(0), opensSeason: false };
    expect(seriesFreshness({ sonarrAddedAt: old, libraryAddedAt: old, latest, seenLatest: false, now: NOW }).arrival).toBe("episode");
  });

  it("un épisode entré hors de la fenêtre ne remonte pas", () => {
    const latest = { episodeId: "e10", at: iso(NEW_BADGE_DAYS + 1), opensSeason: false };
    expect(seriesFreshness({ sonarrAddedAt: old, libraryAddedAt: old, latest, seenLatest: false, now: NOW })).toEqual({ addedAt: old });
  });
});

describe("newBadgeKey — une seule pastille pour le bureau et le téléphone", () => {
  it("un film garde « Nouveau » ; une série dit pourquoi", () => {
    expect(newBadgeKey(iso(1), undefined, NOW)).toBe("cinema.newBadge");
    expect(newBadgeKey(iso(1), "series", NOW)).toBe("cinema.newSeriesBadge");
    expect(newBadgeKey(iso(1), "season", NOW)).toBe("cinema.newSeasonBadge");
    expect(newBadgeKey(iso(1), "episode", NOW)).toBe("cinema.newEpisodeBadge");
    expect(newBadgeKey(iso(40), "episode", NOW)).toBeNull();
  });

  it("la rangée suit la même date : la série ancienne au dernier épisode passe devant", () => {
    const ted = { imdbRating: null, ...seriesFreshness({ sonarrAddedAt: iso(200), libraryAddedAt: iso(200), latest: { episodeId: "e", at: iso(0), opensSeason: false }, seenLatest: false, now: NOW }) };
    const fresh = { imdbRating: null, addedAt: iso(5) };
    expect(recentlyAddedRail([fresh, ted])[0]).toBe(ted);
  });

  it("le badge partagé et les deux accueils lisent `arrival` — aucune vue ne refait la décision", async () => {
    const { readFileSync } = await import("fs");
    for (const f of ["src/components/cinema/CinemaSeriesCard.tsx", "src/components/cinema/mobile/CinemaMobileClient.tsx", "src/components/cinema/CinemaSimilarRow.tsx"]) {
      expect(readFileSync(f, "utf8"), f).toMatch(/<CinemaNewBadge addedAt=\{item\.addedAt\} arrival=/);
    }
    expect(readFileSync("src/components/cinema/CinemaNewBadge.tsx", "utf8")).toMatch(/newBadgeKey\(/);
  });
});

describe("le coût : une lecture de la bibliothèque, pas une requête par série", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const page = (items: unknown[]) =>
    ({ ok: true, status: 200, statusText: "OK", headers: { get: () => "application/json" }, json: async () => ({ Items: items }), text: async () => JSON.stringify({ Items: items }) }) as unknown as Response;

  it("lit par pages triées et s'arrête à la première qui sort de la fenêtre, quel que soit le nombre de séries", async () => {
    const since = NOW - 30 * DAY;
    // 500 épisodes récents de 500 séries différentes, puis une page qui franchit la limite.
    const first = Array.from({ length: 500 }, (_, i) => ({ Id: `e${i}`, SeriesId: `s${i}`, DateCreated: iso(1) }));
    const second = [{ Id: "x", SeriesId: "sx", DateCreated: iso(2) }, { Id: "old", SeriesId: "so", DateCreated: iso(31) }, { Id: "older", SeriesId: "so", DateCreated: iso(40) }];
    const fetchMock = vi.fn().mockResolvedValueOnce(page(first)).mockResolvedValueOnce(page(second)).mockResolvedValue(page([]));
    global.fetch = fetchMock;
    const out = await jellyfin.getRecentEpisodesAdmin(since);
    expect(out).toHaveLength(501);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/IncludeItemTypes=Episode&Recursive=true&SortBy=DateCreated/);
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/StartIndex=500/);
  });

  it("l'état vu d'un compte : un seul appel pour toute la liste", async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([{ Id: "a".repeat(32), UserData: { Played: true } }, { Id: "b".repeat(32), UserData: { Played: false } }]));
    global.fetch = fetchMock;
    const seen = await jellyfin.getPlayedAmong("c".repeat(32), ["a".repeat(32), "b".repeat(32)]);
    expect([...seen]).toEqual(["a".repeat(32)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(`Ids=${"a".repeat(32)},${"b".repeat(32)}`);
  });
});
