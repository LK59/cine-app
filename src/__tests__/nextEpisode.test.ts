import { describe, it, expect } from "vitest";
import { nextEpisodeIn } from "@/lib/nextEpisode";
import type { CinemaSeason } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";

// L'enchaînement automatique : recopié trois fois sans un test jusqu'au 21/09.

const episode = (id: string, seasonNumber: number, episodeNumber: number) =>
  ({ jellyfinItemId: id, seasonNumber, episodeNumber, title: `Épisode ${id}` }) as CinemaSeason["episodes"][number];

const seasons: CinemaSeason[] = [
  { seasonNumber: 1, episodes: [episode("s1e1", 1, 1), episode("s1e2", 1, 2)] },
  { seasonNumber: 2, episodes: [episode("s2e1", 2, 1)] },
];

describe("nextEpisodeIn", () => {
  it("donne l'épisode suivant dans la saison", () => {
    expect(nextEpisodeIn(seasons)("s1e1")).toEqual({ itemId: "s1e2", title: "Épisode s1e2" });
  });

  it("passe à la saison suivante après un final de saison", () => {
    expect(nextEpisodeIn(seasons)("s1e2")?.itemId).toBe("s2e1");
  });

  it("s'arrête après le dernier épisode, et sur un épisode inconnu", () => {
    expect(nextEpisodeIn(seasons)("s2e1")).toBeNull();
    expect(nextEpisodeIn(seasons)("inconnu")).toBeNull();
    expect(nextEpisodeIn([])("s1e1")).toBeNull();
  });
});
