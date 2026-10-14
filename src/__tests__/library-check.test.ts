import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import type { JellyfinItem } from "@/lib/clients/jellyfin";
import type { RadarrMovie } from "@/lib/clients/radarr";
import type { SonarrSeries } from "@/lib/clients/sonarr";

/**
 * Le contrôle de la bibliothèque (DECISIONS.md §90, 14/10/2026) : ses seuils, l'arbitrage par TMDB,
 * les doubles rangements, l'analyse entière sur une bibliothèque de poche, ses routes et sa table.
 * Les cas sont ceux de la bibliothèque de Louis : *Aliens* qui contenait *Alien³* (Special Assembly
 * Cut, 145 min), *November* (2017) qui contenait *Novembre* (2022), *Berlin et La Dame à l'hermine*
 * en double de la saison 2 de *Berlin*.
 */

const session = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: async () => session() }));

import {
  analyseLibrary,
  arbitrateIdentity,
  arbitrateNumbering,
  compareNumbering,
  diskSeasonCounts,
  hardlinkPairs,
  identitiesDisagree,
  misfiledSignals,
  movieIdentityVerdict,
  parseRunTime,
  titleSimilarity,
  yearsInName,
  type CheckDeps,
} from "@/lib/libraryCheck/analyse";
import { arrangeEpisodes } from "@/lib/episodeDisplay";
import { episodeTextTrustDb, libraryCheckDb, LIBRARY_CHECK_VERSION } from "@/lib/libraryCheck/store";
import type { IdentityFinding, MisfiledFinding, NumberingFinding } from "@/lib/libraryCheck/types";

const ep = (Id: string, Name: string, Path: string, season: number, episode: number) =>
  ({ Id, Name, Path, ParentIndexNumber: season, IndexNumber: episode }) as JellyfinItem;
const attached = (file: string, season: number, episode: number, title: string) => ({ file, season, episode, title, overview: null });
const titles = (entries: Record<number, string[]>) => new Map(Object.entries(entries).map(([k, v]) => [Number(k), v]));

beforeEach(() => {
  vi.clearAllMocks();
  session.mockReturnValue({ u: "louis", role: "admin" });
});

describe("les petits outils", () => {
  it("lit la durée de Radarr", () => {
    expect(parseRunTime("2:34:28")).toBeCloseTo(154.47, 1);
    expect(parseRunTime("1:46:17")).toBeCloseTo(106.28, 1);
    expect(parseRunTime("n/a")).toBeNull();
    expect(parseRunTime(undefined)).toBeNull();
  });

  it("lit les années d'un nom — ni « 2160p », ni un nombre du titre", () => {
    expect(yearsInName("Aliens (1986) Special Edition 2160p x265-QTZ.mkv")).toEqual([1986]);
    expect(yearsInName("1917 (2019) 1080p.mkv", "1917")).toEqual([2019]);
    expect(yearsInName("Some.Movie.1080p.mkv")).toEqual([]);
  });

  it("compare des titres sans accents ni ponctuation", () => {
    expect(titleSimilarity("Le Syndrome de Stendhal", "le syndrome de stendhal !")).toBe(1);
    expect(titleSimilarity("Stendhal Syndrome", "The Stendhal Syndrome (Part 1)")).toBeGreaterThanOrEqual(0.8);
    expect(titleSimilarity("Oranges from China", "Demolition Boys")).toBe(0);
  });

  it("deux identités se contredisent sur un identifiant présent des deux côtés, ou sans aucun chez Jellyfin", () => {
    expect(identitiesDisagree({ tmdbId: 679, tvdbId: null, imdbId: "tt0090605" }, { tmdbId: 8077, tvdbId: null, imdbId: null })).toBe(true);
    expect(identitiesDisagree({ tmdbId: 679, tvdbId: null, imdbId: "tt0090605" }, { tmdbId: 679, tvdbId: null, imdbId: null })).toBe(false);
    expect(identitiesDisagree({ tmdbId: 1, tvdbId: null, imdbId: null }, { tmdbId: null, tvdbId: null, imdbId: null })).toBe(true);
  });
});

describe("d. un fichier qui n'est probablement pas son film", () => {
  it("Aliens rangé avec Alien³ : la durée seule ne le voit pas (145 pour 137), le nom d'origine si", () => {
    const r = misfiledSignals({
      title: "Aliens",
      year: 1986,
      expectedMinutes: 137,
      fileMinutes: 145,
      originalNames: ["/downloads/Alien 3 (1992) Special Assembly Cut 1080p.mkv"],
      jellyfinRuntime: 114,
    });
    expect(r.signals).toEqual(["nameYear"]);
    expect(r.nameYears).toEqual([1992]);
    expect(r.originalName).toBe("Alien 3 (1992) Special Assembly Cut 1080p.mkv");
  });

  it("November (2017) avec Novembre (2022) : l'année du nom de fichier, pas celle du dossier de Radarr", () => {
    const r = misfiledSignals({ title: "November", year: 2017, expectedMinutes: 115, fileMinutes: 106, originalNames: ["November (2017)/November (2022) 2160p EAC3.mkv"] });
    expect(r.signals).toEqual(["nameYear"]);
    expect(r.nameYears).toEqual([2022]);
  });

  it("une version longue n'est pas un mauvais fichier (Aliens Special Edition, 154 pour 137)", () => {
    const r = misfiledSignals({
      title: "Aliens",
      year: 1986,
      expectedMinutes: 137,
      fileMinutes: 154,
      originalNames: ["Aliens (1986) Special Edition MULTi VFI 2160p 10bit 4KLight DV HDR BluRay DDP 5.1 Atmos x265-QTZ.mkv"],
    });
    expect(r.signals).toEqual([]);
  });

  it("une version longue annoncée n'en est pas un (Les Deux Tours Extended, 235 pour 179 — mesure du 14/10)", () => {
    const base = { title: "The Lord of the Rings: The Two Towers", year: 2002, expectedMinutes: 179, fileMinutes: 235 };
    expect(misfiledSignals({ ...base, originalNames: ["The Lord of the Rings The Two Towers (2002) Extended MULTi VFI 2160p.mkv"] }).signals).toEqual([]);
    expect(misfiledSignals({ title: "Kingdom of Heaven", year: 2005, expectedMinutes: 144, fileMinutes: 194, originalNames: ["Kingdom of Heaven (2005) REPACK DC Roadshow Version.mkv"] }).signals).toEqual([]);
    expect(misfiledSignals({ ...base, originalNames: [], edition: "Extended" }).signals).toEqual([]);
    // Plus court qu'attendu : aucune édition ne l'explique (*A Good Day to Die Hard*, 15 min pour 98).
    expect(misfiledSignals({ title: "A Good Day to Die Hard", year: 2013, expectedMinutes: 98, fileMinutes: 15, originalNames: [], edition: "Extended" }).signals).toEqual(["duration"]);
  });

  it("une durée juste à trois minutes près l'emporte sur l'année d'une release (Le Chef, « Comme.un.Chef.2014 »)", () => {
    expect(misfiledSignals({ title: "Le Chef", year: 2012, expectedMinutes: 84, fileMinutes: 85, originalNames: ["Comme.un.Chef.2014.FRENCH.1080p.WEB.H265-GL0P.mkv"] }).signals).toEqual([]);
  });

  it("November, fichier remplacé : la durée hésite, l'année du nom départage pour Radarr", () => {
    expect(movieIdentityVerdict(106, 100, 115, { nameYears: [2022], catalogueYear: 2022, jellyfinYear: 2017 })).toBe("catalogue");
    expect(movieIdentityVerdict(106, 100, 115, { nameYears: [2017], catalogueYear: 2022, jellyfinYear: 2017 })).toBe("jellyfin");
    expect(movieIdentityVerdict(106, 100, 115)).toBe("unknown");
  });

  it("la durée : 30 min et 30 % d'écart ensemble, ou moins de la moitié", () => {
    const base = { title: "X", year: 2000, originalNames: [] };
    expect(misfiledSignals({ ...base, expectedMinutes: 100, fileMinutes: 135 }).signals).toEqual(["duration"]);
    expect(misfiledSignals({ ...base, expectedMinutes: 178, fileMinutes: 210 }).signals).toEqual([]); // +18 %, version longue
    expect(misfiledSignals({ ...base, expectedMinutes: 40, fileMinutes: 15 }).signals).toEqual(["duration"]);
  });

  it("le film que Jellyfin croit voir explique la durée", () => {
    const r = misfiledSignals({ title: "X", year: 2000, expectedMinutes: 137, fileMinutes: 114, originalNames: [], jellyfinRuntime: 113 });
    expect(r.signals).toEqual(["jellyfinRuntime"]);
    expect(movieIdentityVerdict(114, 137, 113)).toBe("jellyfin");
    expect(movieIdentityVerdict(137, 137, 113)).toBe("catalogue");
    expect(movieIdentityVerdict(125, 137, 113)).toBe("unknown");
  });
});

describe("c. la numérotation, et TMDB pour arbitre", () => {
  const disk = [ep("a", "Dragon's Return", "/tv/Show/S01E13.mkv", 1, 13), ep("b", "Calm Sea", "/tv/Show/S01E12.mkv", 1, 12)];
  const arranged = arrangeEpisodes(disk, "Show", "fr");

  it("compte les fichiers que Sonarr rattache ailleurs, et ceux qu'il ne rattache pas", () => {
    const c = compareNumbering(arranged, [attached("s01e13.mkv", 2, 1, "A New Journey")]);
    expect(c.compared).toBe(1);
    expect(c.unattached).toBe(1);
    expect(c.mismatched.map((m) => m.arranged.item.Id)).toEqual(["a"]);
    expect(diskSeasonCounts(arranged)).toEqual(new Map([[1, 2]]));
  });

  it("Jellyfin ressemble à TMDB au numéro du disque, Sonarr non : Jellyfin probablement juste", async () => {
    const c = compareNumbering(arranged, [attached("s01e13.mkv", 2, 1, "A New Journey")]);
    const seasonTitles = vi.fn(async () => titles({ 13: ["Le retour du dragon", "Dragon's Return"] }));
    const a = await arbitrateNumbering(c, diskSeasonCounts(arranged), 42, { "1": 2 }, { "1": 12, "2": 12 }, { seasonTitles });
    expect(a.verdict).toBe("jellyfin");
    expect(a.score).toBeGreaterThan(0.3);
    expect(a.seasonCounts).toEqual({ compared: 1, tmdb: 1, sonarr: 0 });
    expect(a.examples[0]).toMatchObject({ disk: "S01E13", jellyfin: "Dragon's Return", sonarr: ["S02E01"], sonarrTitle: "A New Journey", jellyfinScore: 1, sonarrScore: 0 });
    expect(seasonTitles).toHaveBeenCalledWith(42, 1);
  });

  it("Sonarr ressemble à TMDB au numéro du disque : Sonarr probablement juste", async () => {
    const wrong = arrangeEpisodes([ep("a", "Episode 13 bonus", "/tv/Show/S01E13.mkv", 1, 13)], "Show", "fr");
    const c = compareNumbering(wrong, [attached("s01e13.mkv", 2, 1, "Dragon's Return")]);
    const a = await arbitrateNumbering(c, diskSeasonCounts(wrong), 42, null, null, { seasonTitles: async () => titles({ 13: ["Dragon's Return"] }) });
    expect(a.verdict).toBe("catalogue");
  });

  it("sans TMDB ni saisons comparables : indéterminé", async () => {
    const c = compareNumbering(arranged, [attached("s01e13.mkv", 2, 1, "A New Journey")]);
    const a = await arbitrateNumbering(c, diskSeasonCounts(arranged), null, null, null, { seasonTitles: async () => new Map() });
    expect(a.verdict).toBe("unknown");
  });

  it("identité : les titres du disque sont ceux de la série TMDB de Sonarr — Sonarr probablement juste", async () => {
    const a = await arbitrateIdentity(
      arranged,
      { tmdbId: 62104, title: "The Seven Deadly Sins", year: 2014, runtime: null, seasons: { "1": 24 } },
      { tmdbId: 218843, title: "Four Knights of the Apocalypse", year: 2023, runtime: null, seasons: { "1": 24 } },
      null,
      { seasonTitles: async () => titles({ 12: ["Calm Sea"], 13: ["Dragon's Return"] }) }
    );
    expect(a.verdict).toBe("catalogue");
    expect(a.sonarrTitles).toBe(1);
  });
});

describe("e. les doubles rangements", () => {
  it("une paire de dossiers de titre, sans les liens dans un même titre ni hors des racines", () => {
    const lines = [
      "64:1\t/mnt/media/video/tv/Berlin (2023)/Season 2/Berlin (2023) - S02E03.mkv",
      "64:1\t/mnt/media/video/tv/Berlin and the Lady with an Ermine/Season 1/S01E03.mkv",
      "64:2\t/mnt/media/video/tv/Berlin (2023)/Season 2/Berlin (2023) - S02E04.mkv",
      "64:2\t/mnt/media/video/tv/Berlin and the Lady with an Ermine/Season 1/S01E04.mkv",
      "64:3\t/mnt/media/video/tv/JoJo/Season 1/a.mkv",
      "64:3\t/mnt/media/video/tv/JoJo/Season 2/b.mkv",
      "64:4\t/mnt/media/video/downloads/seeds/x.mkv",
      "64:4\t/mnt/media/video/movies/Dune (2021)/Dune.mkv",
    ].join("\n");
    const roots = [
      { prefix: "/mnt/media/video/movies", label: "movies" },
      { prefix: "/mnt/media/video/tv", label: "tv" },
    ];
    expect(hardlinkPairs(lines, roots)).toEqual([{ folders: ["tv/Berlin (2023)", "tv/Berlin and the Lady with an Ermine"], files: 2 }]);
  });
});

describe("l'analyse entière", () => {
  const movie = (id: number, tmdbId: number, title: string, year: number, extra: Partial<RadarrMovie> = {}) =>
    ({ id, tmdbId, title, year, hasFile: true, path: `/movies/${title} (${year})`, runtime: 137, images: [], ...extra }) as RadarrMovie;
  const jf = (Id: string, Name: string, Path: string, ProviderIds: Record<string, string>) => ({ Id, Name, Path, ProviderIds }) as JellyfinItem;
  const show = { id: 12, tvdbId: 284131, tmdbId: 62104, title: "Show", year: 2014, path: "/tv/Show", seriesType: "anime", seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 2, episodeCount: 12, totalEpisodeCount: 12 } }] } as SonarrSeries;

  const deps: CheckDeps = {
    movieFacts: async (id) => (id === 8077 ? { tmdbId: 8077, title: "Alien³", year: 1992, runtime: 114 } : { tmdbId: id, title: "Aliens", year: 1986, runtime: 137 }),
    tvFacts: async (id) => ({ tmdbId: id, title: "Show", year: 2014, runtime: null, seasons: { "1": 2 } }),
    seasonTitles: async () => titles({ 13: ["Dragon's Return"], 12: ["Calm Sea"] }),
  };

  it("range chaque désaccord dans sa catégorie, avec ses faits", async () => {
    const aliens = movie(7, 679, "Aliens", 1986, { movieFile: { originalFilePath: "Alien 3 (1992) Special Assembly Cut.mkv", relativePath: "Aliens (1986).mkv", size: 1, quality: { quality: { name: "x" } }, id: 1, mediaInfo: { runTime: "2:25:00" } } as RadarrMovie["movieFile"] });
    const cure = movie(8, 36095, "Cure", 1997, { runtime: 111, movieFile: { relativePath: "Cure.mkv", size: 1, quality: { quality: { name: "x" } }, id: 2, mediaInfo: { runTime: "1:51:00" } } as RadarrMovie["movieFile"] });
    const { findings, counts } = await analyseLibrary(
      {
        configured: { radarr: true, sonarr: false },
        movies: [aliens, cure],
        series: [show],
        matchedMovies: [
          { m: aliens, jfItem: jf("m-aliens", "Alien³", "/media/movies/Aliens (1986)/Aliens (1986).mkv", { Tmdb: "8077" }) },
          { m: cure, jfItem: jf("m-cure", "La Cure", "/media/movies/Cure (1997)/Cure.mkv", { Tmdb: "999" }) },
        ],
        matchedSeries: [{ s: show, jfItem: jf("s-show", "Show", "/media/tv/Show", { Tvdb: "284131", Tmdb: "62104" }) }],
        onlyMovies: [],
        onlySeries: [{ id: 1_000_000_001, item: jf("s-lcdp", "La casa de papel", "/media/tv/La Casa de Papel", { Tmdb: "71446" }), tmdbId: 71446, tvdbId: null, imdbId: null }],
        seriesData: new Map([
          [12, { attached: [attached("s01e13.mkv", 2, 1, "A New Journey"), attached("s01e12.mkv", 1, 12, "Calm Sea")], episodes: [ep("a", "Dragon's Return", "/tv/Show/S01E13.mkv", 1, 13), ep("b", "Calm Sea", "/tv/Show/S01E12.mkv", 1, 12)] }],
        ]),
        hardlinks: [{ folders: ["tv/Berlin (2023)", "tv/Berlin and the Lady with an Ermine"], files: 8 }],
        trusted: new Set([12]),
      },
      deps
    );
    expect(counts).toEqual({ jellyfinOnly: 1, identity: 1, numbering: 1, misfiled: 1, hardlinks: 1 });

    const misfiled = findings.find((f) => f.category === "misfiled") as MisfiledFinding;
    expect(misfiled).toMatchObject({ title: "Aliens", verdict: "file", signals: ["nameYear"], fileMinutes: 145, expectedMinutes: 137, jellyfinTmdb: { title: "Alien³" } });

    const identity = findings.find((f) => f.category === "identity") as IdentityFinding;
    expect(identity).toMatchObject({ title: "Cure", verdict: "catalogue", catalogue: { tmdbId: 36095 }, jellyfin: { name: "La Cure", tmdbId: 999 } });

    const numbering = findings.find((f) => f.category === "numbering") as NumberingFinding;
    expect(numbering).toMatchObject({ sonarrId: 12, mismatched: 1, compared: 2, trusted: true, seriesType: "anime", verdict: "jellyfin" });

    const only = findings.find((f) => f.category === "jellyfinOnly");
    // Sonarr non configuré : la série que Jellyfin a seule est le fonctionnement normal, pas un oubli.
    expect(only).toMatchObject({ kind: "series", serviceConfigured: false, catalogueId: 1_000_000_001 });
  });
});

describe("ce que le contrôle garde en base", () => {
  it("l'exception par série : posée, lue, retirée", () => {
    episodeTextTrustDb.set(77, true, { title: "One Piece", by: "louis" }, 1000);
    expect(episodeTextTrustDb.has(77)).toBe(true);
    expect(episodeTextTrustDb.all()).toContainEqual({ sonarrId: 77, title: "One Piece", setBy: "louis", createdAt: 1000 });
    episodeTextTrustDb.set(77, false);
    expect(episodeTextTrustDb.has(77)).toBe(false);
  });

  it("le dernier résultat, et un résultat d'une autre forme relu comme absent", () => {
    const result = { version: LIBRARY_CHECK_VERSION, computedAt: 5, durationMs: 1, sources: { radarr: "ok", sonarr: "ok", jellyfin: "ok", tmdb: "ok", media: "ok" }, counts: { jellyfinOnly: 0, identity: 0, numbering: 0, misfiled: 0, hardlinks: 0 }, findings: [] } as const;
    libraryCheckDb.set({ ...result, sources: { ...result.sources }, counts: { ...result.counts }, findings: [] });
    expect(libraryCheckDb.get()?.computedAt).toBe(5);
    libraryCheckDb.set({ ...result, version: LIBRARY_CHECK_VERSION + 1, sources: { ...result.sources }, counts: { ...result.counts }, findings: [] });
    expect(libraryCheckDb.get()).toBeNull();
  });
});

describe("les routes", () => {
  const req = (body?: unknown) => ({ cookies: { get: () => ({ value: "t" }) }, json: async () => body }) as unknown as NextRequest;

  it("refusent un compte ordinaire, même en lecture", async () => {
    session.mockReturnValue({ u: "mathis", role: "user" });
    const { GET, POST } = await import("@/app/api/admin/library-check/route");
    expect((await GET(req())).status).toBe(403);
    expect((await POST(req())).status).toBe(403);
    const trust = await import("@/app/api/admin/library-check/trust/route");
    expect((await trust.POST(req({ sonarrId: 3, trusted: true }))).status).toBe(403);
  });

  it("l'exception se pose sur une série Sonarr, jamais sur un identifiant réservé", async () => {
    const { POST } = await import("@/app/api/admin/library-check/trust/route");
    expect((await POST(req({ sonarrId: 1_000_000_001, trusted: true }))).status).toBe(400);
    expect((await POST(req({ sonarrId: 3, trusted: "oui" }))).status).toBe(400);
    expect((await POST(req({ sonarrId: 3, trusted: true, title: "Frieren" }))).status).toBe(200);
    expect(episodeTextTrustDb.has(3)).toBe(true);
    expect((await POST(req({ sonarrId: 3, trusted: false }))).status).toBe(200);
    expect(episodeTextTrustDb.has(3)).toBe(false);
  });
});
