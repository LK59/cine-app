import { describe, it, expect, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Les épisodes manquants d'une série masquée par les tags bloqués du compte (DECISIONS.md §54).
 *
 * La route ne vérifiait que la session : les identifiants Sonarr se suivent, et n'importe quel compte
 * lisait la grille (titres, dates, téléchargements) d'une série qu'il ne doit pas voir (13/10/2026).
 */
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
vi.mock("@/lib/session", () => ({
  verifySessionFull: async (token?: string) => (token ? { jfId: `jf-${token}`, role: "user" } : null),
}));
vi.mock("@/lib/blockedTags", () => ({
  hiddenTmdbKeysFor: async (jfId?: string | null) => new Set(jfId === "jf-bloque" ? ["series:900"] : []),
}));
vi.mock("@/lib/server-cache", () => ({
  cachedSeries: async () => [{ id: 12, tmdbId: 900 }],
  withCache: async (_k: string, _t: number, fn: () => unknown) => fn(),
  TTL: { SHORT: 15_000 },
}));
vi.mock("@/lib/clients/sonarr", () => ({
  sonarr: {
    getEpisodes: async () => [
      { id: 1, seasonNumber: 2, episodeNumber: 1, title: "Un épisode masqué", hasFile: false, airDate: "2020-01-01" },
    ],
  },
}));
vi.mock("@/lib/downloadProgress", () => ({ sonarrQueue: async () => [], queueProgress: () => null }));

const req = (account: string) =>
  ({ cookies: { get: () => ({ value: account }) } }) as unknown as NextRequest;
const params = { params: Promise.resolve({ sonarrId: "12" }) };

describe("GET /api/player/series/[sonarrId]/missing — tags bloqués", () => {
  it("répond comme si la série n'existait pas pour un compte qui ne la voit pas", async () => {
    const { GET } = await import("@/app/api/player/series/[sonarrId]/missing/route");
    const res = await GET(req("bloque"), params);
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("Un épisode masqué");
  });

  it("répond normalement aux autres comptes", async () => {
    const { GET } = await import("@/app/api/player/series/[sonarrId]/missing/route");
    const res = await GET(req("libre"), params);
    expect(res.status).toBe(200);
    expect((await res.json()).seasons[0].episodes[0].title).toBe("Un épisode masqué");
  });
});
