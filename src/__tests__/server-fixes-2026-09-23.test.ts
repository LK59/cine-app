import { describe, it, expect, vi, beforeEach } from "vitest";

// Relevés par la chasse aux bugs du 23/09/2026 : un cache persistant qui oubliait sa dernière
// bonne valeur au moindre échec, et une note de série gardée « vide » une semaine après un refus.

const { kv, tmdb, omdb } = vi.hoisted(() => ({
  kv: new Map<string, { value: unknown; fetchedAt: number }>(),
  tmdb: { findTvByTvdbId: vi.fn(), getTv: vi.fn(), getMovie: vi.fn() },
  omdb: { isEnabled: () => true, getRating: vi.fn() },
}));
vi.mock("@/lib/db", () => ({
  kvCacheDb: {
    get: (k: string) => kv.get(k) ?? null,
    set: (k: string, value: unknown, fetchedAt: number) => kv.set(k, { value, fetchedAt }),
  },
}));
vi.mock("@/lib/clients/radarr", () => ({ radarr: {} }));
vi.mock("@/lib/clients/sonarr", () => ({ sonarr: {} }));
vi.mock("@/lib/clients/jellyseerr", () => ({ jellyseerr: {} }));
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: {} }));
vi.mock("@/lib/clients/tmdb", () => ({ tmdb }));
vi.mock("@/lib/clients/omdb", () => ({ omdb }));

import { withPersistentCache } from "@/lib/server-cache";
import { getImdbRatingByTvdb } from "@/lib/imdb-rating";

beforeEach(() => {
  vi.clearAllMocks();
  kv.clear();
});

describe("withPersistentCache", () => {
  it("ressert la valeur expirée quand la source ne répond pas, sans la réécrire", async () => {
    kv.set("stale:1", { value: "7.4", fetchedAt: 0 });
    const value = await withPersistentCache("stale:1", 1000, async () => {
      throw new Error("OMDb en pause");
    });
    expect(value).toBe("7.4");
    expect(kv.get("stale:1")?.fetchedAt).toBe(0);
  });

  it("lève toujours quand il n'y a rien à resservir", async () => {
    await expect(
      withPersistentCache("stale:2", 1000, async () => {
        throw new Error("down");
      })
    ).rejects.toThrow("down");
  });
});

describe("getImdbRatingByTvdb", () => {
  // Pendant la pause d'OMDb, toute série ouverte perdait sa note pour sept jours.
  it("ne garde pas un refus d'OMDb comme « pas de note »", async () => {
    tmdb.findTvByTvdbId.mockResolvedValue({ tv_results: [{ id: 1399 }] });
    tmdb.getTv.mockResolvedValue({ external_ids: { imdb_id: "tt0944947" } });
    omdb.getRating.mockRejectedValueOnce(new Error("OMDb en pause après un refus"));
    expect(await getImdbRatingByTvdb(121361)).toBeNull();
    expect(kv.has("imdb:rating:tvdb:121361")).toBe(false);

    omdb.getRating.mockResolvedValueOnce({ Response: "True", imdbRating: "9.2", imdbVotes: "1" });
    expect(await getImdbRatingByTvdb(121361)).toBe("9.2");
  });
});
