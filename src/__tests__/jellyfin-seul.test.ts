import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { JellyfinItem } from "@/lib/clients/jellyfin";

/**
 * Ce que Jellyfin a seul, et la règle de vérité (DECISIONS.md §89, 14/10/2026).
 *
 * Mesuré ce jour-là : 806 films tous rattachés à Radarr par leur dossier, mais trois séries rangées à
 * la main dans Jellyfin, hors Sonarr, jouables et invisibles du cinéma (*La casa de papel*, *Berlin et
 * La Dame à l'hermine*, *Le Flambeau*) ; et des titres que Jellyfin avait pris pour d'autres
 * (*Aliens* lu comme *Alien³*), dont le « vu » et les cartes de reprise suivaient l'erreur.
 */

const radarrMovies = vi.fn();
const sonarrSeries = vi.fn();
const jfMovies = vi.fn();
const jfSeries = vi.fn();
const episodeCount = vi.fn();
const seasons = vi.fn();
const logError = vi.fn();

vi.mock("@/lib/server-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server-cache")>()),
  cachedMovies: () => radarrMovies(),
  cachedSeries: () => sonarrSeries(),
  cachedJellyfinMoviesAdmin: () => jfMovies(),
  cachedJellyfinSeriesAdmin: () => jfSeries(),
  cachedJellyfinEpisodeCount: (id: string) => episodeCount(id),
  cachedJellyfinFirstEpisodes: async () => [],
  cachedJellyfinSeasons: () => seasons(),
  cachedJellyfinRecentEpisodes: async () => [],
  cachedJellyfinPlayedAmong: async () => new Set<string>(),
}));
vi.mock("@/lib/logger", () => ({ logError: (...a: unknown[]) => logError(...a) }));
vi.mock("@/lib/title-art", () => ({
  getTitleArt: async () => ({ posterByLang: {}, posterTextlessUrl: null }),
  logoForLocale: () => null,
}));
vi.mock("@/lib/imdb-rating", () => ({ getImdbRating: async () => null }));
const session = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: async () => session() }));

import { catalogueMembers, jellyfinOnlyMovies } from "@/lib/catalogueMembers";
import { assignJellyfinOnlyIds, isJellyfinOnlyId, jellyfinOnlyIdFor, JELLYFIN_ONLY_ID_BASE } from "@/lib/jellyfinOnlyId";
import { playableLibrary, playableId } from "@/lib/playerLibrary";
import { forgetBlockedTags } from "@/lib/blockedTags";

const movie = (id: number, tmdbId: number, title: string, folder: string, extra: object = {}) => ({
  id, tmdbId, title, year: 2000, hasFile: true, path: `/movies/${folder}`, images: [], genres: ["Drama"], added: "2026-01-01T00:00:00Z", ...extra,
});
const show = (id: number, tvdbId: number, tmdbId: number, title: string, folder: string, files = 8) => ({
  id, tvdbId, tmdbId, title, year: 2020, path: `/tv/${folder}`, images: [], genres: ["Drama"], added: "2026-01-01T00:00:00Z", statistics: { episodeFileCount: files },
});
const jf = (Id: string, Name: string, Path: string, ProviderIds: Record<string, string> = {}, extra: Partial<JellyfinItem> = {}) =>
  ({ Id, Name, Path, ProviderIds, DateCreated: "2026-10-01T00:00:00Z", ...extra }) as JellyfinItem;

function library() {
  radarrMovies.mockResolvedValue([
    movie(7, 679, "Aliens", "Aliens (1986)"),
    movie(8, 438631, "Dune", "Dune (2021)"),
  ]);
  jfMovies.mockResolvedValue([
    // Le dossier d'*Aliens*, que Jellyfin avait pris pour *Alien³*.
    jf("m-aliens", "Alien³", "/media/movies/Aliens (1986)/Alien³.mkv", { Tmdb: "8077" }),
    jf("m-dune", "Dune", "/media/movies/Dune (2021)/Dune.mkv", { Tmdb: "438631" }),
    // Une seconde copie du même film, ailleurs : un identifiant du catalogue, pas une carte de plus.
    jf("m-dune-copie", "Dune", "/media/movies/Dune copie/Dune.mkv", { Tmdb: "438631" }),
    // Un film rangé à la main, sans identifiant : il entre — et il porte un tag bloqué.
    jf("m-maison", "Film de famille", "/media/movies/Film de famille/f.mkv", {}, { Tags: ["prive"], Genres: ["Documentaire"] }),
    // Même titre qu'un film de Radarr, autre dossier, aucun identifiant : un autre film, jamais rapproché par le titre.
    jf("m-dune-1984", "Dune", "/media/movies/Dune (1984)/Dune.mkv", {}, { ProductionYear: 1984 }),
  ]);
  sonarrSeries.mockResolvedValue([
    show(3, 413033, 146176, "Berlin (2023)", "Berlin (2023)", 16),
    show(4, 371079, 94626, "Burning Love (FR)", "Burning Love (FR)", 18),
    // Suivie sans fichier : pas au catalogue.
    show(5, 347325, 80169, "The House of Flowers", "The House of Flowers", 0),
  ]);
  jfSeries.mockResolvedValue([
    jf("s-berlin", "Berlin", "/media/tv/Berlin (2023)", { Tvdb: "413033", Tmdb: "146176" }),
    jf("s-ermine", "Berlin et La Dame à l'hermine", "/media/tv/Berlin and the Lady with an Ermine", { Tvdb: "477676", Tmdb: "308014" }),
    jf("s-flamme", "La Flamme", "/media/tv/Burning Love (FR)", { Tvdb: "371079", Tmdb: "94626" }),
    jf("s-flambeau", "Le Flambeau, les aventuriers de Chupacabra", "/media/tv/Le Flambeau", { Tmdb: "202772" }),
    jf("s-lcdp", "La casa de papel", "/media/tv/La Casa de Papel", { Tvdb: "327417", Tmdb: "71446" }, { Genres: ["Crime"], ImageTags: { Primary: "p1" } }),
    jf("s-flowers", "La casa de las flores", "/media/tv/The House of Flowers", { Tvdb: "347325", Tmdb: "80169" }),
    jf("s-berlin-copie", "Berlin", "/media/tv/Berlin copie", { Tvdb: "413033" }),
  ]);
  const counts: Record<string, number> = { "s-ermine": 8, "s-flambeau": 9, "s-lcdp": 48, "s-flowers": 0, "s-berlin-copie": 8 };
  episodeCount.mockImplementation(async (id: string) => counts[id] ?? 0);
  seasons.mockResolvedValue([1, 2, 3, 4, 5].map((n) => ({ Id: `season-${n}`, SeriesId: "s-lcdp", IndexNumber: n })));
}

beforeEach(() => {
  vi.clearAllMocks();
  forgetBlockedTags();
  session.mockReturnValue(null);
  library();
});
afterEach(() => vi.unstubAllGlobals());

describe("ce que Jellyfin a seul", () => {
  it("entre au catalogue : les séries avec au moins un épisode, les films avec un fichier", async () => {
    const { jellyfinOnly } = await catalogueMembers();
    expect(jellyfinOnly.series.map((t) => t.item.Id).sort()).toEqual(["s-ermine", "s-flambeau", "s-lcdp"]);
    expect(jellyfinOnly.movies.map((t) => t.item.Id).sort()).toEqual(["m-dune-1984", "m-maison"]);
  });

  it("une série vide reste invisible (La casa de las flores)", async () => {
    const { jellyfinOnly, series } = await catalogueMembers();
    expect(jellyfinOnly.series.some((t) => t.item.Id === "s-flowers")).toBe(false);
    expect(series.some((s) => s.id === 5)).toBe(false);
  });

  it("pas de doublon : un élément au même identifiant qu'un titre du catalogue n'est pas une carte de plus", async () => {
    const { jellyfinOnly } = await catalogueMembers();
    const ids = [...jellyfinOnly.movies, ...jellyfinOnly.series].map((t) => t.item.Id);
    expect(ids).not.toContain("m-dune-copie");
    expect(ids).not.toContain("s-berlin-copie");
  });

  it("jamais de rapprochement par le titre : *Dune* (1984), sans identifiant, n'est pas *Dune* de Radarr", async () => {
    const { jellyfinOnly, byJellyfinId } = await catalogueMembers();
    expect(byJellyfinId.get("m-dune")).toMatchObject({ catalogueId: 8, source: "radarr" });
    expect(jellyfinOnly.movies.find((t) => t.item.Id === "m-dune-1984")).toBeDefined();
  });

  it("les doubles rangements voulus sont gardés : chacun sa fiche", async () => {
    const { byJellyfinId } = await catalogueMembers();
    expect(byJellyfinId.get("s-berlin")).toMatchObject({ source: "sonarr", catalogueId: 3 });
    expect(byJellyfinId.get("s-ermine")).toMatchObject({ source: "jellyfin", tmdbId: 308014 });
    expect(byJellyfinId.get("s-flamme")).toMatchObject({ source: "sonarr", catalogueId: 4 });
    expect(byJellyfinId.get("s-flambeau")).toMatchObject({ source: "jellyfin", tmdbId: 202772 });
  });

  it("Radarr ou Sonarr muet : aucun titre « Jellyfin seul » de ce côté — tout Jellyfin paraîtrait orphelin", async () => {
    radarrMovies.mockRejectedValue(new Error("Radarr injoignable"));
    sonarrSeries.mockRejectedValue(new Error("Sonarr injoignable"));
    const { jellyfinOnly } = await catalogueMembers();
    expect(jellyfinOnly).toEqual({ movies: [], series: [] });
  });
});

describe("les identifiants réservés", () => {
  it("sont dans la plage réservée, et les mêmes d'un chargement à l'autre", async () => {
    const first = await catalogueMembers();
    const lcdp = first.jellyfinOnly.series.find((t) => t.item.Id === "s-lcdp")!;
    expect(lcdp.id).toBe(jellyfinOnlyIdFor("s-lcdp"));
    expect(isJellyfinOnlyId(lcdp.id)).toBe(true);
    expect(lcdp.id).toBeLessThan(2 ** 31);
    library();
    expect((await catalogueMembers()).jellyfinOnly.series.find((t) => t.item.Id === "s-lcdp")!.id).toBe(lcdp.id);
  });

  it("une collision est réglée — le suivant libre, toujours le même — et journalisée", () => {
    const wanted = jellyfinOnlyIdFor("bbb");
    const onCollision = vi.fn();
    const ids = assignJellyfinOnlyIds(["bbb", "aaa"], new Set([wanted]), onCollision);
    expect(ids.get("bbb")).toBe(wanted + 1 >= JELLYFIN_ONLY_ID_BASE * 2 ? JELLYFIN_ONLY_ID_BASE : wanted + 1);
    expect(onCollision).toHaveBeenCalledWith("bbb", wanted, ids.get("bbb"));
    // Deux éléments, dans n'importe quel ordre : les mêmes nombres.
    expect(assignJellyfinOnlyIds(["aaa", "bbb"], new Set([wanted]))).toEqual(ids);
  });

  it("le catalogue journalise la collision avec un identifiant de Radarr", () => {
    const taken = jellyfinOnlyIdFor("m-maison");
    const matched = [{ m: movie(taken, 1, "X", "X") as never, jfItem: jf("m-x", "X", "/media/movies/X/x.mkv") }];
    const [t] = jellyfinOnlyMovies([jf("m-maison", "Film de famille", "/media/movies/Film de famille/f.mkv")], matched);
    expect(t.id).not.toBe(taken);
    expect(logError).toHaveBeenCalledWith("catalogue-reserved-id", expect.any(Error), expect.objectContaining({ jellyfinId: "m-maison", wanted: taken }));
  });
});

describe("le catalogue du cinéma", () => {
  const req = (cookie = "") => new Request("https://cine.example/api/cinema/x", { headers: cookie ? { cookie } : {} });

  it("une série que Jellyfin a seule s'y trouve, avec ses saisons Jellyfin et sa date d'entrée", async () => {
    const { GET } = await import("@/app/api/cinema/series/route");
    const body = await (await GET(req())).json();
    const lcdp = body.items.find((i: { jellyfinItemId: string }) => i.jellyfinItemId === "s-lcdp");
    expect(lcdp).toMatchObject({ source: "jellyfin", sonarrId: jellyfinOnlyIdFor("s-lcdp"), tmdbId: 71446, tvdbId: 327417, title: "La casa de papel", seasonCount: 5, genres: ["Crime"] });
    expect(lcdp.posterUrl).toContain("itemId=s-lcdp");
    expect(body.items.some((i: { jellyfinItemId: string }) => i.jellyfinItemId === "s-flowers")).toBe(false);
    // Les doubles rangements : les deux fiches.
    const shown = body.items.map((i: { jellyfinItemId: string }) => i.jellyfinItemId);
    expect(shown).toEqual(expect.arrayContaining(["s-berlin", "s-ermine", "s-flamme", "s-flambeau"]));
    // Un titre de Sonarr n'a pas de `source` : un champ de moins par carte.
    expect(body.items.find((i: { sonarrId: number }) => i.sonarrId === 3)).not.toHaveProperty("source");
  });

  it("un film que Jellyfin a seul s'y trouve, et ses tags bloqués le cachent au compte", async () => {
    const { GET } = await import("@/app/api/cinema/movies/route");
    const all = await (await GET(req())).json();
    const maison = all.items.find((i: { jellyfinItemId: string }) => i.jellyfinItemId === "m-maison");
    expect(maison).toMatchObject({ source: "jellyfin", radarrId: jellyfinOnlyIdFor("m-maison"), title: "Film de famille", addedAt: "2026-10-01T00:00:00Z" });
    expect(all.recentlyAdded).toContain(maison.radarrId);

    session.mockReturnValue({ jfId: "c".repeat(32), role: "user" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ Policy: { BlockedTags: ["Prive"] } }), { status: 200 })));
    const hidden = await (await GET(req("cine_session=t"))).json();
    expect(hidden.items.some((i: { jellyfinItemId: string }) => i.jellyfinItemId === "m-maison")).toBe(false);
    expect(Object.values(hidden.rows).flat()).not.toContain(maison.radarrId);
  });
});

describe("« dans la bibliothèque » — pas « Demander »", () => {
  it("la fiche TMDB d'une série que Jellyfin a seule s'ouvre dans la bibliothèque", async () => {
    const lib = await playableLibrary();
    expect(playableId(lib, "series", 71446)).toBe(jellyfinOnlyIdFor("s-lcdp"));
    expect(lib.series.get(71446)).toMatchObject({ source: "jellyfin" });
    // Son affiche est celle de Jellyfin.
    expect(lib.seriesJellyfin.get(71446)?.Id).toBe("s-lcdp");
    // Un titre de Sonarr garde la sienne.
    expect(playableId(lib, "series", 146176)).toBe(3);
  });
});

describe("le « vu » par le dossier", () => {
  it("le vu d'*Aliens* se range sous Aliens, pas sous Alien³ que Jellyfin avait compris", async () => {
    const { libraryIndex } = await import("@/lib/watched");
    const index = await libraryIndex();
    expect(index?.movies.get(679)).toBe("m-aliens");
    expect(index?.movies.has(8077)).toBe(false);
    expect(index?.byJellyfinId.get("m-aliens")).toEqual({ type: "movie", tmdbId: 679 });
    expect(index?.series.get(71446)).toBe("s-lcdp");
  });
});

describe("la description de fiche d'un titre que Jellyfin a seul", () => {
  it("ne demande rien à Radarr ni à Bazarr, et dit introuvable un identifiant réservé inconnu", async () => {
    const radarrClient = await import("@/lib/clients/radarr");
    const bazarrClient = await import("@/lib/clients/bazarr");
    const getMovie = vi.spyOn(radarrClient.radarr, "getMovie");
    const bazarr = vi.spyOn(bazarrClient.bazarr, "getMovieDetails");
    const { GET } = await import("@/app/api/radarr/movies/[id]/info/route");
    const fake = { cookies: { get: () => undefined } } as never;
    const id = jellyfinOnlyIdFor("m-maison");
    const res = await GET(fake, { params: Promise.resolve({ id: String(id) }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ subtitles: [], activeDownload: null });
    expect((await GET(fake, { params: Promise.resolve({ id: String(JELLYFIN_ONLY_ID_BASE + 1) }) })).status).toBe(404);
    expect(getMovie).not.toHaveBeenCalled();
    expect(bazarr).not.toHaveBeenCalled();
  });
});
