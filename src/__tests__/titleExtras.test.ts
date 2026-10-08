// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { catalogueExtras, extrasFromTranslations } from "@/lib/titleNames";
import { sheetLeadFacts } from "@/lib/sheetFacts";

/**
 * L'accroche et la bande-annonce viennent avec le catalogue (08/10/2026) : elles arrivaient avec
 * la description de la fiche, une demi-seconde après tout le reste.
 */
describe("l'accroche et la bande-annonce du catalogue", () => {
  const data = {
    original_language: "en",
    tagline: "In space no one can hear you scream.",
    translations: {
      translations: [
        { iso_639_1: "fr", iso_3166_1: "CA", data: { tagline: "Accroche canadienne" } },
        { iso_639_1: "fr", iso_3166_1: "FR", data: { tagline: "Dans l'espace, personne ne vous entend crier." } },
        { iso_639_1: "de", iso_3166_1: "DE", data: { tagline: "" } },
      ],
    },
    videos: {
      results: [
        { key: "en-teaser", site: "YouTube", type: "Teaser", official: true, iso_639_1: "en" },
        { key: "en-off", site: "YouTube", type: "Trailer", official: true, iso_639_1: "en" },
        { key: "fr-fan", site: "YouTube", type: "Trailer", official: false, iso_639_1: "fr" },
        { key: "fr-off", site: "YouTube", type: "Trailer", official: true, iso_639_1: "fr" },
      ],
    },
  };

  it("prend l'accroche du pays de la langue, et celle d'origine pour un film tourné en anglais", () => {
    const { taglines } = extrasFromTranslations(data);
    expect(taglines.fr).toBe("Dans l'espace, personne ne vous entend crier.");
    expect(taglines.en).toBe("In space no one can hear you scream.");
    expect(taglines.de).toBe("");
  });

  it("choisit la bande-annonce comme la fiche, dans les langues de vidéo de chaque interface", () => {
    const { trailers } = extrasFromTranslations(data);
    // La première officielle dans l'ordre de TMDB, parmi les langues acceptées — exactement ce que
    // fait la fiche avec la même liste (`pickTrailer`).
    expect(trailers.fr).toBe("en-off");
    expect(trailers.en).toBe("en-off");
  });

  it("dit « pas encore su » par l'absence, et « rien » par une chaîne vide ou null", () => {
    expect(catalogueExtras(null, "fr")).toEqual({});
    expect(catalogueExtras({ taglines: {}, trailers: {} }, "fr")).toEqual({ tagline: "", trailerKey: null, castNames: [] });
  });
});

describe("la fiche", () => {
  it("montre ce que le catalogue sait dès l'ouverture, sans attendre la description", () => {
    const lead = sheetLeadFacts({ tagline: "Accroche", trailerKey: "abc" }, undefined, false);
    expect(lead).toMatchObject({ taglineKnown: true, tagline: "Accroche", taglineLate: false, trailerKnown: true, trailerKey: "abc", trailerLate: false });
  });

  it("attend la description pour un titre que le catalogue ne sait pas encore", () => {
    expect(sheetLeadFacts({}, undefined, false)).toMatchObject({ taglineKnown: false, trailerKnown: false });
    const lead = sheetLeadFacts({}, { tmdb: { tagline: "Tard" }, trailerKey: "xyz" }, true);
    expect(lead).toMatchObject({ tagline: "Tard", taglineLate: true, trailerKey: "xyz", trailerLate: true });
  });
});

describe("les noms de la bannière", () => {
  it("viennent du même appel, cinq au plus, les mêmes dans toutes les langues", () => {
    const cast = Array.from({ length: 8 }, (_, i) => ({ name: `Acteur ${i}` }));
    const extras = extrasFromTranslations({ credits: { cast } });
    expect(extras.cast).toEqual(["Acteur 0", "Acteur 1", "Acteur 2", "Acteur 3", "Acteur 4"]);
    expect(catalogueExtras(extras, "de").castNames).toEqual(extras.cast);
  });
});

describe("la durée d'un épisode", () => {
  it("vient avec le catalogue, par la même règle que la fiche", async () => {
    const { tvEpisodeRuntime } = await import("@/lib/tvRuntime");
    const extras = extrasFromTranslations({ episode_run_time: [], last_episode_to_air: { runtime: 43 } });
    // Sonarr d'abord quand TMDB ne donne pas de durée type, puis le dernier épisode diffusé.
    expect(tvEpisodeRuntime(extras.tvRuntime ?? null, null)).toBe(43);
    expect(tvEpisodeRuntime(extras.tvRuntime ?? null, 50)).toBe(50);
  });

  it("s'affiche dès l'ouverture quand le catalogue la sait, en fondu sinon", async () => {
    const { sheetEpisodeRuntime } = await import("@/lib/sheetFacts");
    expect(sheetEpisodeRuntime(43, undefined)).toEqual({ minutes: 43, late: false });
    expect(sheetEpisodeRuntime(undefined, 45)).toEqual({ minutes: 45, late: true });
    expect(sheetEpisodeRuntime(undefined, undefined)).toEqual({ minutes: null, late: true });
  });
});

describe("la bannière du bureau", () => {
  it("lit le synopsis et les noms dans le catalogue, sans rien demander", async () => {
    const { renderHook } = await import("@testing-library/react");
    const { useHeroInfo } = await import("@/lib/useHeroInfo");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useHeroInfo("movie", 603, { overview: "Néo découvre la Matrice.", castNames: ["Keanu Reeves"] }));
    expect(result.current).toEqual({ tmdb: { overview: "Néo découvre la Matrice.", cast: [{ name: "Keanu Reeves" }] } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
