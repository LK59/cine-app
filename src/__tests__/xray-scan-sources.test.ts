import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `readWatching` (DECISIONS.md §138, le palier 1 du planificateur) : une liste « Reprendre » ou « À suivre »
 * illisible lève au lieu de valoir « rien en cours » (chasse aux défauts du 11/11/2026 — une panne passagère
 * de Jellyfin vidait le palier 1 pour dix minutes). Un compte que Jellyfin refuse (4xx) n'a simplement rien.
 */

const jf = vi.hoisted(() => ({
  resumeError: null as Error | null,
  nextUpError: null as Error | null,
}));

vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getUsers: async () => [{ Id: "u1" }, { Id: "u2" }],
    getResumeItems: async (userId: string) => {
      if (jf.resumeError && userId === "u2") throw jf.resumeError;
      return { Items: [{ Id: (userId === "u1" ? "a" : "b").repeat(32), Type: "Movie" }] };
    },
    getNextUpGlobal: async (userId: string) => {
      if (jf.nextUpError && userId === "u2") throw jf.nextUpError;
      return [];
    },
    getEpisodesAdmin: async () => [],
  },
}));
vi.mock("@/lib/server-cache", () => ({
  cachedJellyfinMoviesAdmin: async () => [],
  cachedJellyfinSeriesAdmin: async () => [],
  cachedMovies: async () => [],
  cachedSeries: async () => [],
  getProviderIdCI: () => undefined,
}));
vi.mock("@/lib/xray/scanStore", () => ({ anyAnimation: () => false }));

import { HttpError } from "@/lib/http";
import { readWatching } from "@/lib/xray/scanSources";

beforeEach(() => {
  jf.resumeError = null;
  jf.nextUpError = null;
});

describe("readWatching", () => {
  it("les listes de chaque compte, jointes", async () => {
    expect([...(await readWatching()).keys()]).toEqual(["a".repeat(32), "b".repeat(32)]);
  });

  it("Jellyfin injoignable ou en erreur pour un compte : lève, le palier 1 n'est pas vidé", async () => {
    jf.resumeError = new TypeError("fetch failed");
    await expect(readWatching()).rejects.toThrow("fetch failed");
    jf.resumeError = null;
    jf.nextUpError = new HttpError("Jellyfin : 502", 502);
    await expect(readWatching()).rejects.toThrow("502");
  });

  it("un compte que Jellyfin refuse (supprimé entre-temps) n'a rien en cours, les autres restent", async () => {
    jf.resumeError = new HttpError("Jellyfin : 404", 404);
    expect([...(await readWatching()).keys()]).toEqual(["a".repeat(32)]);
  });
});
