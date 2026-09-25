import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Les titres dans la langue de qui regarde.
 *
 * Le 23/09/2026, le catalogue montrait « What's in a Name » pour *Le Prénom* et « The Return of
 * Martin Guerre » pour *Le Retour de Martin Guerre* : le titre de Radarr, toujours en anglais.
 */

const { tmdb, kv } = vi.hoisted(() => ({
  tmdb: { isEnabled: vi.fn(() => true), getMovieTranslations: vi.fn(), getTvTranslations: vi.fn() },
  kv: new Map<string, { value: unknown; fetchedAt: number }>(),
}));
vi.mock("@/lib/clients/tmdb", () => ({ tmdb }));
vi.mock("@/lib/db", () => ({
  kvCacheDb: {
    get: (k: string) => kv.get(k) ?? null,
    set: (k: string, value: unknown, fetchedAt: number) => kv.set(k, { value, fetchedAt }),
  },
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

import { getTitleNames, localizedTitle, namesFromTranslations, resetTitleNames } from "@/lib/titleNames";

const PRENOM = {
  original_language: "en",
  original_title: "What's in a Name",
  translations: {
    translations: [
      { iso_639_1: "fr", iso_3166_1: "CA", data: { title: "Le Prénom (Québec)" } },
      { iso_639_1: "fr", iso_3166_1: "FR", data: { title: "Le Prénom" } },
      { iso_639_1: "de", iso_3166_1: "DE", data: { title: "" } },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  kv.clear();
  resetTitleNames();
});

describe("namesFromTranslations", () => {
  it("prend la traduction du pays de la langue, et ignore une traduction vide", () => {
    expect(namesFromTranslations(PRENOM)).toEqual({ en: "What's in a Name", fr: "Le Prénom" });
  });

  it("lit `name` pour une série", () => {
    expect(namesFromTranslations({ translations: { translations: [{ iso_639_1: "fr", iso_3166_1: "FR", data: { name: "Le Bureau des légendes" } }] } }))
      .toEqual({ fr: "Le Bureau des légendes" });
  });

  // Mesuré en production le 23/09/2026 : TMDB ne liste pas la langue d'origine parmi les
  // traductions. Sans le titre d'origine, un film français restait sous son titre anglais.
  it("prend le titre d'origine pour la langue d'origine", () => {
    expect(
      namesFromTranslations({
        original_language: "fr",
        original_title: "Le Retour de Martin Guerre",
        translations: { translations: [{ iso_639_1: "en", iso_3166_1: "US", data: { title: "The Return of Martin Guerre" } }] },
      })
    ).toEqual({ fr: "Le Retour de Martin Guerre", en: "The Return of Martin Guerre" });
  });
});

describe("getTitleNames", () => {
  // Le catalogue entier est construit à chaque requête : attendre TMDB pour chaque titre inconnu
  // aurait bloqué la première ouverture après un déploiement.
  it("ne bloque jamais : rien d'abord, la traduction à la requête suivante", async () => {
    tmdb.getMovieTranslations.mockResolvedValue(PRENOM);
    expect(getTitleNames(77338, "movie")).toEqual({});
    await vi.waitFor(() => expect(getTitleNames(77338, "movie")).toEqual({ en: "What's in a Name", fr: "Le Prénom" }));
    expect(tmdb.getMovieTranslations).toHaveBeenCalledTimes(1);
  });

  it("relit le cache disque sans rappeler TMDB", () => {
    kv.set("tmdb:titles:v2:movie:77338", { value: { fr: "Le Prénom" }, fetchedAt: Date.now() });
    expect(getTitleNames(77338, "movie")).toEqual({ fr: "Le Prénom" });
    expect(tmdb.getMovieTranslations).not.toHaveBeenCalled();
  });

  it("ressert une traduction périmée pendant qu'il la rafraîchit", () => {
    tmdb.getMovieTranslations.mockResolvedValue(PRENOM);
    kv.set("tmdb:titles:v2:movie:77338", { value: { fr: "Le Prénom" }, fetchedAt: 0 });
    expect(getTitleNames(77338, "movie")).toEqual({ fr: "Le Prénom" });
    expect(tmdb.getMovieTranslations).toHaveBeenCalledTimes(1);
  });

  it("ne demande qu'une fois un titre en cours de recherche", () => {
    tmdb.getTvTranslations.mockReturnValue(new Promise(() => {}));
    getTitleNames(1, "series");
    getTitleNames(1, "series");
    expect(tmdb.getTvTranslations).toHaveBeenCalledTimes(1);
  });
});

describe("localizedTitle", () => {
  it("montre le titre de la langue, et garde l'ancien pour la recherche", () => {
    expect(localizedTitle({ fr: "Le Prénom" }, "fr", "What's in a Name")).toEqual({ title: "Le Prénom", aka: "What's in a Name" });
  });

  it("garde le titre d'origine quand la langue n'a pas de traduction", () => {
    expect(localizedTitle({ fr: "Le Prénom" }, "es", "What's in a Name")).toEqual({ title: "What's in a Name" });
  });
});

// Pendant une panne de TMDB, chaque ouverture du catalogue relançait la recherche de chaque titre.
describe("getTitleNames — après un échec", () => {
  it("attend une heure avant de redemander", async () => {
    vi.useFakeTimers();
    tmdb.getMovieTranslations.mockRejectedValue(new Error("down"));
    getTitleNames(1, "movie");
    await vi.waitFor(() => expect(tmdb.getMovieTranslations).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(0);
    getTitleNames(1, "movie");
    expect(tmdb.getMovieTranslations).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3600_000);
    getTitleNames(1, "movie");
    expect(tmdb.getMovieTranslations).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe("le synopsis dans la langue de qui regarde (25/09/2026)", () => {
  it("tire chaque langue des traductions, pays de préférence d'abord", async () => {
    const { overviewsFromTranslations } = await import("@/lib/titleNames");
    const overviews = overviewsFromTranslations({
      original_language: "en",
      translations: {
        translations: [
          { iso_639_1: "fr", iso_3166_1: "CA", data: { overview: "Résumé québécois" } },
          { iso_639_1: "fr", iso_3166_1: "FR", data: { overview: "Résumé français" } },
          { iso_639_1: "de", iso_3166_1: "DE", data: { overview: "  " } },
        ],
      },
    });
    expect(overviews).toEqual({ fr: "Résumé français" });
  });

  it("retombe sur le synopsis du catalogue quand la langue manque", async () => {
    const { localizedOverview } = await import("@/lib/titleNames");
    expect(localizedOverview({ fr: "Résumé" }, "fr", "Summary")).toBe("Résumé");
    expect(localizedOverview({ fr: "Résumé" }, "de", "Summary")).toBe("Summary");
    expect(localizedOverview({}, "fr", null)).toBeNull();
  });
});
