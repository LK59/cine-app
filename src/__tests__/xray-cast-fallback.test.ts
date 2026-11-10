import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/http";

// Un épisode que TMDB ne connaît pas (404) prend la distribution de la série ; toute autre erreur reste
// une erreur (« La Flamme » S02E04, 10/11/2026 : l'élément échouait et l'épisode restait sans X-Ray).
const calls: string[] = [];
let episodeError: Error | null = null;
vi.mock("@/lib/clients/tmdb", () => ({
  TMDB_IMAGE_BASE: "https://image.tmdb.org/t/p",
  tmdb: {
    getEpisodeCredits: async (tv: number, s: number, e: number) => {
      calls.push(`episode:${tv}:${s}:${e}`);
      if (episodeError) throw episodeError;
      return { cast: [{ id: 1, name: "Régulier", character: "Héros", order: 0, profile_path: null }], guest_stars: [] };
    },
    getTvAggregateCredits: async (tv: number) => {
      calls.push(`aggregate:${tv}`);
      return {
        cast: [
          { id: 2, name: "Second", order: 1, profile_path: "/b.jpg", roles: [{ character: "Ami", episode_count: 9 }] },
          { id: 1, name: "Premier", order: 0, profile_path: "/a.jpg", roles: [{ character: "Rare", episode_count: 1 }, { character: "Héros", episode_count: 8 }] },
        ],
      };
    },
  },
}));
vi.mock("@/lib/server-cache", () => ({
  withCache: (_k: string, _t: number, fn: () => Promise<unknown>) => fn(),
  withPersistentCache: (_k: string, _t: number, fn: () => Promise<unknown>) => fn(),
  getProviderIdCI: (ids: Record<string, string> | undefined, key: string) => ids?.[key],
}));

beforeEach(() => {
  calls.length = 0;
  episodeError = null;
});

describe("distribution d'un épisode inconnu de TMDB", () => {
  it("un épisode connu garde sa propre distribution, sans appel à la série", async () => {
    const { castOf } = await import("@/lib/xray/cast");
    const cast = await castOf({ kind: "episode", tvId: 94626, season: 1, episode: 2 });
    expect(cast.map((p) => p.name)).toEqual(["Régulier"]);
    expect(calls).toEqual(["episode:94626:1:2"]);
  });

  it("un 404 prend la distribution de la série, dans l'ordre du générique, rôles du plus joué au moins joué", async () => {
    episodeError = new HttpError("404 Not Found: {}", 404);
    const { castOf } = await import("@/lib/xray/cast");
    const cast = await castOf({ kind: "episode", tvId: 94626, season: 2, episode: 4 });
    expect(cast.map((p) => [p.personId, p.character, p.order])).toEqual([
      [1, "Héros / Rare", 0],
      [2, "Ami", 1],
    ]);
    expect(calls).toEqual(["episode:94626:2:4", "aggregate:94626"]);
  });

  it("une autre erreur (TMDB indisponible) n'est pas masquée", async () => {
    episodeError = new HttpError("503 Service Unavailable", 503);
    const { castOf } = await import("@/lib/xray/cast");
    await expect(castOf({ kind: "episode", tvId: 94626, season: 2, episode: 4 })).rejects.toThrow("503");
    expect(calls).toEqual(["episode:94626:2:4"]);
  });
});
