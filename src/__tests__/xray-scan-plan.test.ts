import { describe, it, expect } from "vitest";
import {
  analysisSpeed,
  buildPlan,
  episodesFrom,
  etaSeconds,
  isAnimationGenre,
  isLibraryPath,
  libraryRoots,
  NEW_WINDOW_MS,
  sameDuration,
  watchingRanks,
  type LibraryEntry,
} from "@/lib/xray/scanPlan";

/**
 * L'ordre de l'analyse de la bibliothèque en fond (DECISIONS.md §138, planificateur) : paliers,
 * exclusions, la chaîne des épisodes, la durée égale à une seconde près, la vitesse et l'estimation.
 */

const id = (c: string) => c.repeat(32);
const DAY = 24 * 3600_000;
const NOW = Date.UTC(2026, 10, 9);

function entry(over: Partial<LibraryEntry> & { itemId: string }): LibraryEntry {
  return { kind: "Movie", title: over.itemId.slice(0, 4), seriesId: null, durationS: 3600, importedAt: null, createdAt: null, animation: false, ...over };
}

describe("l'animation est écartée", () => {
  it("reconnaît le genre dans les langues de Jellyfin, TMDB et TVDB", () => {
    expect(isAnimationGenre(["Drame", "Animation"])).toBe(true);
    expect(isAnimationGenre(["Anime"])).toBe(true);
    expect(isAnimationGenre(["Animación"])).toBe(true);
    expect(isAnimationGenre(["Zeichentrick"])).toBe(true);
    expect(isAnimationGenre(["Drame", "Familial"])).toBe(false);
    expect(isAnimationGenre(undefined)).toBe(false);
  });

  it("un élément d'animation reste au plan, marqué écarté", () => {
    const plan = buildPlan([entry({ itemId: id("a"), animation: true })], new Map(), NOW);
    expect(plan[0].excluded).toBe("animation");
  });
});

describe("la chaîne des épisodes", () => {
  const eps = [
    { Id: "s1e2", ParentIndexNumber: 1, IndexNumber: 2 },
    { Id: "s1e1", ParentIndexNumber: 1, IndexNumber: 1 },
    { Id: "s2e1", ParentIndexNumber: 2, IndexNumber: 1 },
    { Id: "s2e2", ParentIndexNumber: 2, IndexNumber: 2 },
    { Id: "s2e3", ParentIndexNumber: 2, IndexNumber: 3 },
    { Id: "s2e4", ParentIndexNumber: 2, IndexNumber: 4 },
    { Id: "s2e5", ParentIndexNumber: 2, IndexNumber: 5 },
    { Id: "sp1", ParentIndexNumber: 0, IndexNumber: 1 },
  ];
  it("l'épisode en cours et les quatre suivants, saison suivante comprise, sans les spéciaux", () => {
    expect(episodesFrom(eps, "s1e2")).toEqual(["s1e2", "s2e1", "s2e2", "s2e3", "s2e4"]);
    expect(episodesFrom(eps, "s2e4")).toEqual(["s2e4", "s2e5"]);
    expect(episodesFrom(eps, "inconnu")).toEqual([]);
  });
});

describe("le palier 1 : ce qui se regarde", () => {
  it("le premier titre de chaque compte avant le deuxième de quiconque, les épisodes d'avance ensuite", () => {
    const chain = [1, 2, 3, 4, 5, 6].map((n) => ({ Id: `e${n}`, ParentIndexNumber: 1, IndexNumber: n }));
    const ranks = watchingRanks(
      [
        [
          { itemId: "e2", kind: "Episode", seriesId: "serie" },
          { itemId: "film2", kind: "Movie", seriesId: null },
        ],
        [{ itemId: "film1", kind: "Movie", seriesId: null }],
      ],
      (sid) => (sid === "serie" ? chain : undefined),
    );
    const order = [...ranks.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k);
    expect(order).toEqual(["e2", "film1", "film2", "e3", "e4", "e5", "e6"]);
    expect(ranks.has("e1")).toBe(false);
  });
});

describe("les paliers", () => {
  it("1 ce qu'on regarde, 2 les arrivées des deux dernières semaines, 3 le reste du plus récent au plus ancien", () => {
    const lib = [
      entry({ itemId: id("1"), importedAt: NOW - 400 * DAY }),
      entry({ itemId: id("2"), importedAt: NOW - 2 * DAY }),
      entry({ itemId: id("3"), importedAt: NOW - 100 * DAY }),
      entry({ itemId: id("4"), importedAt: NOW - 30 * DAY }),
      // Sans date d'import (ni Radarr ni Sonarr) : la date de Jellyfin sert de repli.
      entry({ itemId: id("5"), importedAt: null, createdAt: NOW - DAY }),
    ];
    const plan = buildPlan(lib, new Map([[id("1"), 1]]), NOW);
    const tier = (x: string) => plan.find((p) => p.itemId === id(x))!.tier;
    expect(tier("1")).toBe(1);
    expect(tier("2")).toBe(2);
    expect(tier("5")).toBe(2);
    expect(tier("3")).toBe(3);
    expect(tier("4")).toBe(3);
    const rest = plan.filter((p) => p.tier === 3).sort((a, b) => a.rank - b.rank).map((p) => p.itemId);
    expect(rest).toEqual([id("4"), id("3")]);
    expect(NEW_WINDOW_MS).toBe(14 * DAY);
  });
});

describe("la durée égale, la vitesse, l'estimation", () => {
  it("à une seconde près, jamais sur une durée inconnue", () => {
    expect(sameDuration(2551.36, 2552.2)).toBe(true);
    expect(sameDuration(2551.36, 2553)).toBe(false);
    expect(sameDuration(null, 2551)).toBe(false);
    expect(sameDuration(0, 0)).toBe(false);
  });

  it("la vitesse pèse chaque élément par sa durée", () => {
    expect(analysisSpeed([{ durationS: 3600, computeS: 360 }, { durationS: 600, computeS: 240 }])).toBeCloseTo(4200 / 600);
    expect(analysisSpeed([])).toBeNull();
  });

  it("le temps restant : la vidéo qui reste à la vitesse mesurée", () => {
    expect(etaSeconds(36_000, 10)).toBe(3600);
    expect(etaSeconds(0, null)).toBe(0);
    expect(etaSeconds(100, null)).toBeNull();
  });
});

describe("les dossiers permis", () => {
  it("films et séries seulement, chemins détournés refusés", () => {
    expect(isLibraryPath("/media/movies/Alien (1979)/Alien.mkv")).toBe(true);
    expect(isLibraryPath("/media/tv/MacGyver/Season 01/S01E01.mkv")).toBe(true);
    expect(isLibraryPath("/media/downloads/complete/x.mkv")).toBe(false);
    expect(isLibraryPath("/media/books/x.epub")).toBe(false);
    expect(isLibraryPath("/media/movies-seeds/x.mkv")).toBe(false);
    expect(isLibraryPath("/media/movies/../downloads/x.mkv")).toBe(false);
    expect(isLibraryPath("/media/movies")).toBe(false);
    expect(isLibraryPath("media/movies/x.mkv")).toBe(false);
    expect(isLibraryPath(null)).toBe(false);
  });

  it("une autre installation règle les siens", () => {
    process.env.XRAY_LIBRARY_ROOTS = "/data/films/, /data/series";
    try {
      expect(libraryRoots()).toEqual(["/data/films", "/data/series"]);
      expect(isLibraryPath("/data/series/x.mkv")).toBe(true);
      expect(isLibraryPath("/media/movies/x.mkv")).toBe(false);
    } finally {
      delete process.env.XRAY_LIBRARY_ROOTS;
    }
  });
});
