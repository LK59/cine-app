import { describe, it, expect, vi, beforeEach } from "vitest";

// Saison 3 de *The Creep Tapes*, 23/09/2026 : sans traduction française sur TMDB, les épisodes
// arrivaient sans résumé et sous « Épisode 2 ». « Mieux vaut l'anglais que pas d'info. »

const { seasons } = vi.hoisted(() => ({ seasons: new Map<string, unknown>() }));
vi.mock("@/lib/clients/tmdb", () => ({
  createTmdbClient: (lang: string) => ({
    getTvSeason: vi.fn(async (id: number, s: number) => {
      const data = seasons.get(`${lang}:${id}:${s}`);
      if (!data) throw new Error("404");
      return data;
    }),
  }),
}));
vi.mock("@/lib/server-cache", () => ({
  withPersistentCache: async (_k: string, _t: number, fn: () => Promise<unknown>) => fn(),
}));

import { fillEpisodeText, isPlaceholderTitle } from "@/lib/episodeFallback";

const ep = (n: number, title: string, overview: string | null) => ({ seasonNumber: 3, episodeNumber: n, title, overview });

beforeEach(() => seasons.clear());

describe("fillEpisodeText", () => {
  it("comble en anglais ce que le français n'a pas", async () => {
    seasons.set("fr-FR:256201:3", { episodes: [{ episode_number: 2, name: "Épisode 2", overview: "" }] });
    seasons.set("en-US:256201:3", { episodes: [{ episode_number: 2, name: "MO", overview: "A local New Yorker is stalked." }] });
    const episodes = [ep(2, "Épisode 2", null)];
    await fillEpisodeText(episodes, 256201, "fr");
    expect(episodes[0]).toMatchObject({ title: "MO", overview: "A local New Yorker is stalked." });
  });

  it("préfère la langue de qui regarde quand elle existe", async () => {
    seasons.set("fr-FR:1:3", { episodes: [{ episode_number: 1, name: "Le Retour", overview: "Résumé français." }] });
    seasons.set("en-US:1:3", { episodes: [{ episode_number: 1, name: "The Return", overview: "English." }] });
    const episodes = [ep(1, "Épisode 1", null)];
    await fillEpisodeText(episodes, 1, "fr");
    expect(episodes[0]).toMatchObject({ title: "Le Retour", overview: "Résumé français." });
  });

  it("ne touche jamais à ce que Jellyfin a déjà, ni ne demande rien quand rien ne manque", async () => {
    const episodes = [ep(1, "Pilote", "Déjà là.")];
    await fillEpisodeText(episodes, 1, "fr");
    expect(episodes[0]).toMatchObject({ title: "Pilote", overview: "Déjà là." });
  });

  it("laisse les épisodes tels quels quand TMDB ne répond pas", async () => {
    const episodes = [ep(1, "Épisode 1", null)];
    await fillEpisodeText(episodes, 1, "fr");
    expect(episodes[0]).toMatchObject({ title: "Épisode 1", overview: null });
  });
});

describe("isPlaceholderTitle", () => {
  it("reconnaît les titres de remplissage, dans les quatre langues", () => {
    for (const t of ["Épisode 2", "Episode 12", "Episodio 3", "Folge 4"]) expect(isPlaceholderTitle(t)).toBe(true);
    expect(isPlaceholderTitle("L'Épisode du siècle")).toBe(false);
  });
});
