import { describe, it, expect, vi } from "vitest";
import { episodeRowFacts, playEpisodeFrom } from "@/lib/episodeRow";
import { formatDurationShort, formatMinutes } from "@/lib/format";

/**
 * La ligne d'un épisode (DECISIONS.md §114.6) : le temps restant d'un épisode commencé, sinon sa durée,
 * et « À suivre » — la règle que l'écran des épisodes du bureau, la fiche du téléphone et la fiche d'un
 * lien de partage écrivaient chacune.
 */
const ep = (over: Partial<Parameters<typeof episodeRowFacts>[0]> = {}) => ({
  jellyfinItemId: "e1",
  title: "Pilote",
  watched: false,
  resumeTicks: null,
  runtimeTicks: 28_200_000_000,
  runtimeMinutes: 47,
  ...over,
});

describe("episodeRowFacts", () => {
  it("un épisode commencé dit ce qui reste, pas sa durée", () => {
    expect(episodeRowFacts(ep({ resumeTicks: 6_000_000_000 }), null)).toEqual({
      remaining: formatDurationShort(28_200_000_000 - 6_000_000_000),
      runtime: null,
      isNext: false,
    });
  });

  it("un épisode vu, même commencé, redit sa durée", () => {
    expect(episodeRowFacts(ep({ resumeTicks: 6_000_000_000, watched: true }), null)).toEqual({ remaining: null, runtime: formatMinutes(47), isNext: false });
  });

  it("jamais commencé : la durée ; sans durée connue : rien", () => {
    expect(episodeRowFacts(ep(), null).runtime).toBe(formatMinutes(47));
    expect(episodeRowFacts(ep({ runtimeMinutes: null }), null)).toEqual({ remaining: null, runtime: null, isNext: false });
  });

  it("commencé mais sans durée : ni reste ni durée inventés", () => {
    expect(episodeRowFacts(ep({ resumeTicks: 6_000_000_000, runtimeTicks: null, runtimeMinutes: null }), null)).toEqual({ remaining: null, runtime: null, isNext: false });
  });

  it("« À suivre » : l'épisode que Lire lancerait", () => {
    expect(episodeRowFacts(ep(), "e1").isNext).toBe(true);
    expect(episodeRowFacts(ep(), "e2").isNext).toBe(false);
    expect(episodeRowFacts(ep(), undefined).isNext).toBe(false);
  });
});

describe("playEpisodeFrom", () => {
  it("lance l'épisode là où il en est, avec la suite de la série", () => {
    const play = vi.fn();
    const next = () => null;
    playEpisodeFrom({ play }, ep({ resumeTicks: 6_000_000_000 }), next);
    expect(play).toHaveBeenCalledWith({ itemId: "e1", title: "Pilote", resumeAt: 600, getNextEpisode: next });
  });

  it("un épisode jamais commencé part de zéro, dit explicitement", () => {
    const play = vi.fn();
    playEpisodeFrom({ play }, ep(), undefined);
    expect(play.mock.calls[0][0].resumeAt).toBe(0);
  });
});
