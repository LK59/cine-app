import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import type { JellyfinItem } from "@/lib/clients/jellyfin";

/**
 * Les épisodes selon la règle de vérité (DECISIONS.md §89, 14/10/2026) : le rangement vient du disque
 * (Jellyfin), l'identité de l'épisode du rattachement de Sonarr (épisode ↔ fichier), le texte de
 * TMDB par le TMDB du catalogue — et un épisode que Jellyfin sait mal (sans numéro, sous son nom de
 * fichier) s'affiche quand même proprement.
 */

const { seasons, tmdbCalls, cached } = vi.hoisted(() => ({
  seasons: new Map<string, unknown>(),
  tmdbCalls: [] as string[],
  cached: new Map<string, unknown>(),
}));
vi.mock("@/lib/clients/tmdb", async () => {
  const { HttpError } = await import("@/lib/http");
  return {
    createTmdbClient: (lang: string) => ({
      getTvSeason: vi.fn(async (id: number, s: number) => {
        tmdbCalls.push(`${lang}:${id}:${s}`);
        const data = seasons.get(`${lang}:${id}:${s}`);
        if (!data) throw new HttpError("404 Not Found", 404);
        return data;
      }),
    }),
  };
});

const mockEpisodes = vi.fn();
const mockNextUp = vi.fn();
const mockProviderIds = vi.fn();
const mockSonarrSeries = vi.fn();
const mockAttached = vi.fn();
vi.mock("@/lib/server-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server-cache")>()),
  withPersistentCache: async (key: string, _t: number, fn: () => Promise<unknown>) => {
    const value = await fn();
    cached.set(key, value);
    return value;
  },
  cachedItemProviderIds: () => mockProviderIds(),
  cachedSeries: () => mockSonarrSeries(),
  cachedSonarrEpisodeTexts: () => mockAttached(),
}));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
vi.mock("@/lib/session", () => ({ verifySessionFull: async () => ({ jfId: "u1" }) }));
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getSeriesEpisodes: (...a: unknown[]) => mockEpisodes(...a),
    getNextUp: (...a: unknown[]) => mockNextUp(...a),
  },
}));
const mockLinks = vi.fn();
vi.mock("@/lib/sonarrLink", () => ({ catalogueLinks: () => mockLinks() }));

import { arrangeEpisodes, episodeNumbersFromPath, isMeaninglessTitle } from "@/lib/episodeDisplay";
import { applyAttachedEpisodeText, fillEpisodeText } from "@/lib/episodeFallback";

const item = (Id: string, Name: string, Path: string, season?: number, episode?: number, extra: Partial<JellyfinItem> = {}) =>
  ({ Id, Name, Path, ParentIndexNumber: season, IndexNumber: episode, SeriesName: "La casa de papel", ...extra }) as JellyfinItem;

beforeEach(() => {
  vi.clearAllMocks();
  seasons.clear();
  cached.clear();
  tmdbCalls.length = 0;
});

describe("un épisode que Jellyfin sait mal", () => {
  it("lit saison et numéro dans le nom du fichier", () => {
    expect(episodeNumbersFromPath("/media/tv/Le Flambeau/Season 1/Le Flambeau - S01E03.mkv")).toEqual({ season: 1, episode: 3 });
    expect(episodeNumbersFromPath("/x/show.s2e10.mkv")).toEqual({ season: 2, episode: 10 });
    expect(episodeNumbersFromPath("/x/Bonus.mkv")).toBeNull();
  });

  it("sans numéro : celui du fichier, sinon après le dernier de la saison — jamais É0 en tête", () => {
    const arranged = arrangeEpisodes(
      [
        item("a", "Le début", "/s/S01E01.mkv", 1, 1),
        item("b", "Coulisses", "/s/Coulisses.mkv", 1, undefined),
        item("c", "La suite", "/s/Show - S01E02.mkv", 1, undefined),
        item("d", "Bêtisier", "/s/Betisier.mkv", 1, undefined),
      ],
      "Show",
      "fr"
    );
    expect(arranged.map((a) => [a.item.Id, a.seasonNumber, a.episodeNumber])).toEqual([
      ["a", 1, 1],
      ["b", 1, 4],
      ["c", 1, 2],
      ["d", 1, 3],
    ]);
  });

  it("un titre qui n'est que le nom du fichier, ou celui de la série, devient « Épisode N »", () => {
    const [byFile, bySeries, real] = arrangeEpisodes(
      [
        item("a", "La Casa de Papel - S04E01", "/m/La Casa de Papel - S04E01.mkv", 4, 1),
        item("b", "La casa de papel", "/m/x.mkv", 4, 2),
        item("c", "Game over", "/m/La Casa de Papel - S04E03.mkv", 4, 3),
      ],
      "La casa de papel",
      "fr"
    );
    expect(byFile.title).toBe("Épisode 1");
    expect(bySeries.title).toBe("Épisode 2");
    expect(real.title).toBe("Game over");
    expect(arrangeEpisodes([item("a", "x", "/m/x.mkv", 1, 7)], null, "en")[0].title).toBe("Episode 7");
    expect(isMeaninglessTitle("", null, null)).toBe(true);
  });
});

describe("le complément TMDB", () => {
  it("rien si TMDB n'a pas la saison — et l'absence est gardée, pas redemandée à chaque ouverture", async () => {
    const episodes = [{ seasonNumber: 5, episodeNumber: 1, title: "Épisode 1", overview: null }];
    await fillEpisodeText(episodes, 71446, "fr");
    expect(episodes[0]).toEqual({ seasonNumber: 5, episodeNumber: 1, title: "Épisode 1", overview: null });
    expect(cached.get("tmdb:season-text:fr-FR:71446:5")).toEqual([]);
  });
});

describe("le texte de l'épisode que Sonarr a rattaché au fichier", () => {
  const attached = (file: string, season: number, episode: number, title: string, overview: string | null = null) => ({ file, season, episode, title, overview });

  it("même épisode des deux côtés, même série : le texte de Jellyfin, déjà traduit, est gardé", async () => {
    const eps = [{ seasonNumber: 1, episodeNumber: 1, title: "Les 7 péchés capitaux", overview: "Résumé.", path: "/m/S01E01.mkv" }];
    const settled = await applyAttachedEpisodeText(eps, [attached("s01e01.mkv", 1, 1, "The Seven Deadly Sins")], 62104, true, "fr");
    expect(settled.size).toBe(0);
    expect(eps[0].title).toBe("Les 7 péchés capitaux");
  });

  // *The Seven Deadly Sins* (14/10/2026) : Jellyfin lisait le dossier comme sa suite, et donnait aux
  // épisodes les titres d'une autre série.
  it("série que Jellyfin a prise pour une autre : le texte de l'épisode de Sonarr, par TMDB, en français", async () => {
    seasons.set("fr-FR:62104:1", { episodes: [{ episode_number: 2, name: "L'épée du Chevalier Sacré", overview: "Résumé FR." }] });
    const eps = [{ seasonNumber: 1, episodeNumber: 2, title: "LA FORCE INCONNUE", overview: "Mauvais résumé.", path: "/m/S01E02.mkv" }];
    const settled = await applyAttachedEpisodeText(eps, [attached("s01e02.mkv", 1, 2, "The Sword of the Holy Knight")], 62104, false, "fr");
    expect(settled.has(eps[0])).toBe(true);
    expect(eps[0]).toMatchObject({ title: "L'épée du Chevalier Sacré", overview: "Résumé FR." });
  });

  it("un autre numéro chez Sonarr : le texte de son épisode, le numéro du disque reste", async () => {
    seasons.set("en-US:9:2", { episodes: [{ episode_number: 1, name: "We're Back", overview: "Rio is captured." }] });
    const eps = [{ seasonNumber: 3, episodeNumber: 1, title: "Au bout du rouleau", overview: "Autre épisode.", path: "/m/x.mkv" }];
    await applyAttachedEpisodeText(eps, [attached("x.mkv", 2, 1, "We're Back")], 9, true, "fr");
    expect(eps[0]).toMatchObject({ seasonNumber: 3, episodeNumber: 1, title: "We're Back", overview: "Rio is captured." });
  });

  it("TMDB muet : le titre de Sonarr — sauf un « TBA » qui n'en est pas un", async () => {
    const eps = [
      { seasonNumber: 1, episodeNumber: 1, title: "Épisode 1", overview: null, path: "/m/a.mkv" },
      { seasonNumber: 1, episodeNumber: 2, title: "Épisode 2", overview: null, path: "/m/b.mkv" },
    ];
    await applyAttachedEpisodeText(eps, [attached("a.mkv", 1, 1, "Pilot", "Sonarr overview."), attached("b.mkv", 1, 2, "TBA")], 5, false, "fr");
    expect(eps[0]).toMatchObject({ title: "Pilot", overview: "Sonarr overview." });
    expect(eps[1].title).toBe("Épisode 2");
  });

  it("un fichier que Sonarr n'a pas rattaché garde le texte de Jellyfin", async () => {
    const eps = [{ seasonNumber: 1, episodeNumber: 1, title: "Titre JF", overview: "JF.", path: "/m/inconnu.mkv" }];
    expect((await applyAttachedEpisodeText(eps, [attached("autre.mkv", 1, 1, "X")], 5, false, "fr")).size).toBe(0);
    expect(eps[0].title).toBe("Titre JF");
  });
});

describe("GET /api/cinema/series/[id]/episodes — la règle de vérité", () => {
  const SERIES = "0123456789abcdef0123456789abcdef";
  const req = { cookies: { get: () => ({ value: "t" }) } } as unknown as NextRequest;
  const params = { params: Promise.resolve({ jellyfinId: SERIES }) };

  it("une série que Jellyfin a seule : numéros du disque, remplissage, TMDB du catalogue seulement pour les saisons qu'il a", async () => {
    mockLinks.mockResolvedValue(new Map([[SERIES, { type: "series", catalogueId: 1_234_567_890, tmdbId: 71446, source: "jellyfin" }]]));
    mockProviderIds.mockResolvedValue({ ProviderIds: { Tmdb: "71446" } });
    mockNextUp.mockResolvedValue(null);
    mockEpisodes.mockResolvedValue([
      item("e1", "La Casa de Papel - S04E01", "/m/La Casa de Papel - S04E01.mkv", 4, 1),
      item("e2", "La Casa de Papel - S04E02", "/m/La Casa de Papel - S04E02.mkv", 4, undefined),
      item("e3", "On est de retour", "/m/La Casa de Papel - S03E01.mkv", 3, 1),
    ]);
    seasons.set("fr-FR:71446:3", { episodes: [{ episode_number: 1, name: "On est de retour", overview: "Rio est fait prisonnier." }] });
    const { GET } = await import("@/app/api/cinema/series/[jellyfinId]/episodes/route");
    const body = await (await GET(req, params)).json();
    const s4 = body.seasons.find((s: { seasonNumber: number }) => s.seasonNumber === 4);
    expect(s4.episodes.map((e: { episodeNumber: number; title: string }) => [e.episodeNumber, e.title])).toEqual([
      [1, "Épisode 1"],
      [2, "Épisode 2"],
    ]);
    const s3 = body.seasons.find((s: { seasonNumber: number }) => s.seasonNumber === 3);
    expect(s3.episodes[0]).toMatchObject({ title: "On est de retour", overview: "Rio est fait prisonnier." });
    expect(s3.episodes[0]).not.toHaveProperty("path");
    expect(mockAttached).not.toHaveBeenCalled();
  });

  it("une série Sonarr que Jellyfin a mal identifiée : TMDB de Sonarr, jamais celui de Jellyfin", async () => {
    mockLinks.mockResolvedValue(new Map([[SERIES, { type: "series", catalogueId: 12, tmdbId: 62104, source: "sonarr" }]]));
    mockProviderIds.mockResolvedValue({ ProviderIds: { Tmdb: "218843", Tvdb: "420018" } });
    mockSonarrSeries.mockResolvedValue([{ id: 12, tvdbId: 284131, tmdbId: 62104, title: "The Seven Deadly Sins" }]);
    mockAttached.mockResolvedValue([{ file: "the seven deadly sins - s01e01.mkv", season: 1, episode: 1, title: "The Seven Deadly Sins", overview: null }]);
    mockNextUp.mockResolvedValue(null);
    mockEpisodes.mockResolvedValue([
      item("e1", "LE DÉPART DU GARÇON", "/m/The Seven Deadly Sins - S01E01.mkv", 1, 1, { SeriesName: "The Seven Deadly Sins" }),
      item("e2", "Épisode 2", "/m/inconnu.mkv", 1, 2, { SeriesName: "The Seven Deadly Sins" }),
    ]);
    seasons.set("fr-FR:62104:1", {
      episodes: [
        { episode_number: 1, name: "Les 7 péchés capitaux", overview: "Une princesse." },
        { episode_number: 2, name: "L'épée du Chevalier Sacré", overview: "Suite." },
      ],
    });
    const { GET } = await import("@/app/api/cinema/series/[jellyfinId]/episodes/route");
    const body = await (await GET(req, params)).json();
    expect(body.seasons[0].episodes.map((e: { title: string }) => e.title)).toEqual(["Les 7 péchés capitaux", "L'épée du Chevalier Sacré"]);
    expect(tmdbCalls.some((c) => c.includes(":218843:"))).toBe(false);
  });
});
