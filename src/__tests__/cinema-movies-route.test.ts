import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCachedMovies = vi.fn();
const mockCachedJellyfinMoviesAdmin = vi.fn();
const mockCachedJellyfinMovies = vi.fn();

// Full replace, not importOriginal — the real module's other exports pull in every client
// (radarr/sonarr/jellyseerr/...), each destructuring its own config.* section that a minimal
// mock config wouldn't provide (same issue hit building the trickplay preview route earlier this
// session). findJellyfinMovieByTmdb is reimplemented here (TMDB-id pass only, matching the real
// one's primary match) since these tests only exercise that path.
vi.mock("@/lib/server-cache", () => ({
  cachedMovies: (...a: unknown[]) => mockCachedMovies(...a),
  cachedJellyfinMoviesAdmin: (...a: unknown[]) => mockCachedJellyfinMoviesAdmin(...a),
  cachedJellyfinMovies: (...a: unknown[]) => mockCachedJellyfinMovies(...a),
  findJellyfinMovieByTmdb: (items: { Id: string; ProviderIds?: { Tmdb?: string } }[], tmdbId: number) =>
    items.find((i) => i.ProviderIds?.Tmdb === String(tmdbId)) ?? null,
}));

function radarrMovie(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: "Some Movie",
    year: 2020,
    monitored: true,
    hasFile: true,
    status: "released",
    images: [],
    qualityProfileId: 1,
    sizeOnDisk: 0,
    tmdbId: 100,
    genres: ["Action"],
    added: "2024-01-01T00:00:00Z",
    ratings: { imdb: { value: 7.55, votes: 100 } },
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/cinema/movies", () => {
  it("excludes movies not yet downloaded (hasFile=false)", async () => {
    mockCachedMovies.mockResolvedValue([radarrMovie({ hasFile: false })]);
    mockCachedJellyfinMoviesAdmin.mockResolvedValue([{ Id: "a".repeat(32), ProviderIds: { Tmdb: "100" } }]);

    const { GET } = await import("@/app/api/cinema/movies/route");
    const body = await (await GET()).json();

    expect(body.genres).toEqual([]);
    expect(body.spotlight).toEqual([]);
  });

  it("excludes a downloaded movie with no resolved Jellyfin item", async () => {
    mockCachedMovies.mockResolvedValue([radarrMovie()]);
    mockCachedJellyfinMoviesAdmin.mockResolvedValue([]); // no match

    const { GET } = await import("@/app/api/cinema/movies/route");
    const body = await (await GET()).json();

    expect(body.genres).toEqual([]);
  });

  it("puts a multi-genre movie into every one of its genre rows", async () => {
    mockCachedMovies.mockResolvedValue([radarrMovie({ genres: ["Action", "Comedy"] })]);
    mockCachedJellyfinMoviesAdmin.mockResolvedValue([{ Id: "a".repeat(32), ProviderIds: { Tmdb: "100" } }]);

    const { GET } = await import("@/app/api/cinema/movies/route");
    const body = await (await GET()).json();

    expect(body.genres.sort()).toEqual(["Action", "Comedy"]);
    expect(body.rows.Action).toHaveLength(1);
    expect(body.rows.Comedy).toHaveLength(1);
    expect(body.rows.Action[0].radarrId).toBe(1);
  });

  it("derives imdbRating from Radarr's own ratings field, formatted to one decimal", async () => {
    mockCachedMovies.mockResolvedValue([radarrMovie({ ratings: { imdb: { value: 8, votes: 1 } } })]);
    mockCachedJellyfinMoviesAdmin.mockResolvedValue([{ Id: "a".repeat(32), ProviderIds: { Tmdb: "100" } }]);

    const { GET } = await import("@/app/api/cinema/movies/route");
    const body = await (await GET()).json();

    expect(body.rows.Action[0].imdbRating).toBe("8.0");
  });

  it("resolves jellyfinItemId onto the returned movie", async () => {
    mockCachedMovies.mockResolvedValue([radarrMovie()]);
    mockCachedJellyfinMoviesAdmin.mockResolvedValue([{ Id: "b".repeat(32), ProviderIds: { Tmdb: "100" } }]);

    const { GET } = await import("@/app/api/cinema/movies/route");
    const body = await (await GET()).json();

    expect(body.rows.Action[0].jellyfinItemId).toBe("b".repeat(32));
  });

  it("sorts spotlight by most-recently-added and caps it at 10, skipping unmatched items", async () => {
    const movies = Array.from({ length: 12 }, (_, i) =>
      radarrMovie({ id: i + 1, tmdbId: 100 + i, added: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` })
    );
    mockCachedMovies.mockResolvedValue(movies);
    mockCachedJellyfinMoviesAdmin.mockResolvedValue(
      // Item tmdbId=100 (the oldest "added") deliberately has no Jellyfin match.
      movies.filter((m) => m.tmdbId !== 100).map((m) => ({ Id: `${m.id}`.padStart(32, "0"), ProviderIds: { Tmdb: String(m.tmdbId) } }))
    );

    const { GET } = await import("@/app/api/cinema/movies/route");
    const body = await (await GET()).json();

    expect(body.spotlight).toHaveLength(10);
    // Most recently added (2024-01-12, tmdbId 111) comes first.
    expect(body.spotlight[0].tmdbId).toBe(111);
    expect(body.spotlight.some((m: { tmdbId: number }) => m.tmdbId === 100)).toBe(false);
  });
});

describe("GET /api/cinema/movies — which Jellyfin view", () => {
  // Mesuré sur l'installation : `/Users/{id}/Items` renvoie 546 films là où la vue serveur en
  // compte 674, pour un compte administrateur ayant accès à tout — le parcours par vues ne
  // descend pas dans tout l'arbre. Cent vingt-huit films manquaient au catalogue, dont un que
  // Louis regardait : sa reprise ouvrait une fiche introuvable, donc rien.
  it("reads the server-wide view, not a per-account one", async () => {
    mockCachedMovies.mockResolvedValue([radarrMovie()]);
    mockCachedJellyfinMoviesAdmin.mockResolvedValue([{ Id: "a".repeat(32), ProviderIds: { Tmdb: "100" } }]);

    const { GET } = await import("@/app/api/cinema/movies/route");
    const body = await (await GET()).json();

    expect(mockCachedJellyfinMoviesAdmin).toHaveBeenCalled();
    expect(mockCachedJellyfinMovies).not.toHaveBeenCalled();
    expect(body.spotlight).toHaveLength(1);
  });
});
