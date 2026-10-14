import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * « Recommandé pour vous » nomme les films qui l'ont réellement semée (14/10/2026, DECISIONS.md §52).
 *
 * L'étiquette disait « Parce que vous avez regardé Interstellar » — le dernier film vu — alors que
 * les trois derniers semaient la rangée. Elle porte désormais `basedOn` : les films regardés qui ont
 * un identifiant TMDB **et** ont apporté au moins un titre resté dans la rangée, le plus récent
 * d'abord.
 */

const { mockTmdb, mockJellyfin, mockHidden } = vi.hoisted(() => ({
  mockTmdb: {
    isEnabled: vi.fn(() => true),
    trendingMovies: vi.fn(async () => ({ results: [] })),
    trendingTv: vi.fn(async () => ({ results: [] })),
    movieRecommendations: vi.fn(),
  },
  mockJellyfin: { getRecentlyPlayed: vi.fn() },
  mockHidden: vi.fn(async () => new Set<string>()),
}));
vi.mock("@/lib/clients/tmdb", () => ({ createTmdbClient: () => mockTmdb, TMDB_IMAGE_BASE: "https://img" }));
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: mockJellyfin }));
vi.mock("@/lib/server-cache", () => ({
  withCache: async (_key: string, _ttl: number, fn: () => unknown) => fn(),
  TTL: { MEDIUM: 1, LONG: 1 },
  getProviderIdCI: (ids: Record<string, string> | undefined, key: string) =>
    ids ? Object.entries(ids).find(([k]) => k.toLowerCase() === key)?.[1] : undefined,
}));
vi.mock("@/lib/playerLibrary", () => ({ playableLibrary: async () => ({ movies: new Map(), series: new Map() }) }));
vi.mock("@/lib/blockedTags", () => ({ hiddenTmdbKeysFor: () => mockHidden() }));
vi.mock("@/lib/i18n", () => ({ getTmdbLocale: () => "fr-FR", LOCALE_COOKIE: "locale" }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "session" }));
vi.mock("@/lib/session", () => ({ verifySessionFull: async () => ({ jfId: "u1", role: "user" }) }));
vi.mock("@/lib/api-helpers", () => ({
  withErrorHandling: async (fn: () => Promise<unknown>) => Response.json(await fn()),
}));

import { GET } from "@/app/api/player/discover/route";

const req = { cookies: { get: () => ({ value: "x" }) } } as unknown as NextRequest;

const watched = (name: string, tmdb?: number) => ({ Name: name, ProviderIds: tmdb ? { Tmdb: String(tmdb) } : {} });
const reco = (id: number, vote = 7.5) => ({ id, title: `T${id}`, release_date: "2020-01-01", poster_path: `/p${id}.jpg`, vote_average: vote });

async function recommendedRow() {
  const res = await GET(req);
  const body = (await res.json()) as { rows: { key: string; basedOn?: string[]; items: { tmdbId: number }[] }[] };
  return body.rows.find((r) => r.key === "recommended");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHidden.mockResolvedValue(new Set());
});

describe("/api/player/discover — basedOn", () => {
  it("les trois films, le plus récent d'abord, quand chacun a apporté un titre", async () => {
    mockJellyfin.getRecentlyPlayed.mockResolvedValue({
      Items: [watched("Interstellar", 1), watched("Dune", 2), watched("Premier contact", 3)],
    });
    mockTmdb.movieRecommendations.mockImplementation(async (id: number) => ({ results: [reco(id * 100)] }));
    const row = await recommendedRow();
    expect(row?.basedOn).toEqual(["Interstellar", "Dune", "Premier contact"]);
    expect(row).not.toHaveProperty("becauseOf");
  });

  it("seulement ceux qui ont contribué : sans TMDB id, réponse en échec, rien de retenu", async () => {
    mockJellyfin.getRecentlyPlayed.mockResolvedValue({
      Items: [watched("Sans identifiant"), watched("Interstellar", 1), watched("En échec", 2), watched("Dune", 3), watched("Rien de bon", 4)],
    });
    mockTmdb.movieRecommendations.mockImplementation(async (id: number) => {
      if (id === 2) throw new Error("TMDB 500");
      if (id === 4) return { results: [reco(400, 5)] }; // note trop basse : rien de retenu
      return { results: [reco(id * 100)] };
    });
    const row = await recommendedRow();
    expect(row?.basedOn).toEqual(["Interstellar", "Dune"]);
  });

  it("un titre déjà apporté par une graine plus récente ne compte pas pour la suivante", async () => {
    mockJellyfin.getRecentlyPlayed.mockResolvedValue({ Items: [watched("Interstellar", 1), watched("Dune", 2)] });
    mockTmdb.movieRecommendations.mockResolvedValue({ results: [reco(500)] });
    const row = await recommendedRow();
    expect(row?.basedOn).toEqual(["Interstellar"]);
    expect(row?.items.map((i) => i.tmdbId)).toEqual([500]);
  });

  it("une graine dont tous les titres sont cachés par les tags bloqués n'est pas nommée", async () => {
    mockJellyfin.getRecentlyPlayed.mockResolvedValue({ Items: [watched("Interstellar", 1), watched("Dune", 2)] });
    mockTmdb.movieRecommendations.mockImplementation(async (id: number) => ({ results: [reco(id * 100)] }));
    mockHidden.mockResolvedValue(new Set(["movie:100"]));
    const row = await recommendedRow();
    expect(row?.basedOn).toEqual(["Dune"]);
    expect(row?.items.map((i) => i.tmdbId)).toEqual([200]);
  });
});
