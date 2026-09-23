/** La route ne lit de la requête que ce qui décide du cache : deux en-têtes. */
function fakeReq(headers: Record<string, string> = {}): Request {
  return new Request("https://cine.example/api/cinema", { headers });
}

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

// Les traductions de TMDB, sans TMDB : un seul film en a une ici. `localizedTitle` reste le vrai.
vi.mock("@/lib/titleNames", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/titleNames")>()),
  getTitleNames: (tmdbId: number) => (tmdbId === 77338 ? { fr: "Le Prénom", en: "What's in a Name" } : {}),
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
    const body = await (await GET(fakeReq())).json();

    expect(body.genres).toEqual([]);
    expect(body.spotlight).toEqual([]);
  });

  it("excludes a downloaded movie with no resolved Jellyfin item", async () => {
    mockCachedMovies.mockResolvedValue([radarrMovie()]);
    mockCachedJellyfinMoviesAdmin.mockResolvedValue([]); // no match

    const { GET } = await import("@/app/api/cinema/movies/route");
    const body = await (await GET(fakeReq())).json();

    expect(body.genres).toEqual([]);
  });

  it("puts a multi-genre movie into every one of its genre rows", async () => {
    mockCachedMovies.mockResolvedValue([radarrMovie({ genres: ["Action", "Comedy"] })]);
    mockCachedJellyfinMoviesAdmin.mockResolvedValue([{ Id: "a".repeat(32), ProviderIds: { Tmdb: "100" } }]);

    const { GET } = await import("@/app/api/cinema/movies/route");
    const body = await (await GET(fakeReq())).json();

    expect(body.genres.sort()).toEqual(["Action", "Comedy"]);
    // Les rangées ne portent plus que des identifiants : un film à deux genres est écrit une
    // seule fois dans `items` et cité deux fois. C'est tout l'objet de la déduplication.
    expect(body.rows.Action).toEqual([1]);
    expect(body.rows.Comedy).toEqual([1]);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].radarrId).toBe(1);
  });

  it("derives imdbRating from Radarr's own ratings field, formatted to one decimal", async () => {
    mockCachedMovies.mockResolvedValue([radarrMovie({ ratings: { imdb: { value: 8, votes: 1 } } })]);
    mockCachedJellyfinMoviesAdmin.mockResolvedValue([{ Id: "a".repeat(32), ProviderIds: { Tmdb: "100" } }]);

    const { GET } = await import("@/app/api/cinema/movies/route");
    const body = await (await GET(fakeReq())).json();

    expect(body.items[0].imdbRating).toBe("8.0");
  });

  it("resolves jellyfinItemId onto the returned movie", async () => {
    mockCachedMovies.mockResolvedValue([radarrMovie()]);
    mockCachedJellyfinMoviesAdmin.mockResolvedValue([{ Id: "b".repeat(32), ProviderIds: { Tmdb: "100" } }]);

    const { GET } = await import("@/app/api/cinema/movies/route");
    const body = await (await GET(fakeReq())).json();

    expect(body.items[0].jellyfinItemId).toBe("b".repeat(32));
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
    const body = await (await GET(fakeReq())).json();

    expect(body.spotlight).toHaveLength(10);
    // Most recently added (2024-01-12, tmdbId 111) comes first.
    // `spotlight` ne porte plus que des identifiants : on retrouve le titre dans `items`.
    const parId = new Map<number, { tmdbId: number }>(body.items.map((m: { radarrId: number; tmdbId: number }) => [m.radarrId, m]));
    expect(parId.get(body.spotlight[0])!.tmdbId).toBe(111);
    expect(body.spotlight.some((id: number) => parId.get(id)?.tmdbId === 100)).toBe(false);
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
    const body = await (await GET(fakeReq())).json();

    expect(mockCachedJellyfinMoviesAdmin).toHaveBeenCalled();
    expect(mockCachedJellyfinMovies).not.toHaveBeenCalled();
    expect(body.spotlight).toHaveLength(1);
  });
});

// Le catalogue fait un mégaoctet et demi, et il était retéléchargé à chaque retour sur l'onglet.
// Une étiquette et « no-cache » donnent l'entre-deux qu'on veut : le navigateur redemande toujours
// — la bibliothèque bouge — mais une réponse inchangée ne coûte plus qu'un 304.
describe("GET /api/cinema/movies — ce qui repart sur le réseau", () => {
  it("tags the answer and asks the browser to revalidate rather than to keep it blindly", async () => {
    const { GET } = await import("@/app/api/cinema/movies/route");
    const res = await GET(fakeReq());
    expect(res.headers.get("etag")).toMatch(/^W\/"/);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
  });

  it("answers 304 with no body when nothing has changed", async () => {
    const { GET } = await import("@/app/api/cinema/movies/route");
    const etag = (await GET(fakeReq())).headers.get("etag")!;
    const res = await GET(fakeReq({ "if-none-match": etag }));
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  it("compresses when the browser says it can", async () => {
    const { GET } = await import("@/app/api/cinema/movies/route");
    const plain = await GET(fakeReq());
    const gzipped = await GET(fakeReq({ "accept-encoding": "gzip, deflate, br" }));
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(gzipped.headers.get("content-encoding")).toBe("gzip");
    const compressed = Number(gzipped.headers.get("content-length"));
    expect(compressed).toBeGreaterThan(0);
    expect(compressed).toBeLessThan((await plain.text()).length);
  });
});

describe("la charge utile ne répète plus les titres", () => {
  // Elle partait avec chaque titre sérialisé une fois par genre : 689 films devenaient 1730
  // entrées sur cette bibliothèque, soit deux fois et demie ce qu'il fallait — et c'est la
  // ressource qui bloque l'écran d'accueil sur un réseau faible.
  it("écrit chaque titre une fois, quel que soit son nombre de genres", async () => {
    mockCachedMovies.mockResolvedValue([
      radarrMovie({ id: 1, tmdbId: 100, genres: ["Action", "Comedy", "Drama"] }),
    ]);
    mockCachedJellyfinMoviesAdmin.mockResolvedValue([{ Id: "a".repeat(32), ProviderIds: { Tmdb: "100" } }]);

    const { GET } = await import("@/app/api/cinema/movies/route");
    const body = await (await GET(fakeReq())).json();

    expect(body.items).toHaveLength(1);
    expect(body.rows.Action).toEqual([1]);
    expect(body.rows.Comedy).toEqual([1]);
    expect(body.rows.Drama).toEqual([1]);
    // Et la sérialisation ne contient qu'un seul exemplaire du titre.
    expect(JSON.stringify(body).split(radarrMovie({}).title).length - 1).toBe(1);
  });
});

// Le 23/09/2026 : « What's in a Name » pour *Le Prénom*, le titre de Radarr, toujours en anglais.
describe("GET /api/cinema/movies — le titre dans la langue de qui regarde", () => {
  async function body(cookie: string) {
    mockCachedMovies.mockResolvedValue([
      radarrMovie({ id: 5, tmdbId: 77338, title: "What's in a Name", originalTitle: "Le Prénom" }),
    ]);
    mockCachedJellyfinMoviesAdmin.mockResolvedValue([{ Id: "jf-5", ProviderIds: { Tmdb: "77338" } }]);
    const { GET } = await import("@/app/api/cinema/movies/route");
    return (await GET(fakeReq({ cookie }))).json();
  }

  it("montre le titre français, et garde celui de Radarr pour la recherche", async () => {
    const { items } = await body("cine-lang=fr");
    expect(items[0].title).toBe("Le Prénom");
    expect(items[0].aka).toBe("What's in a Name");
    // Le titre d'origine est celui qu'on affiche : inutile de le répéter.
    expect(items[0].originalTitle).toBeUndefined();
  });

  it("montre le titre anglais à qui lit en anglais", async () => {
    const { items } = await body("cine-lang=en");
    expect(items[0].title).toBe("What's in a Name");
    expect(items[0].aka).toBeUndefined();
    expect(items[0].originalTitle).toBe("Le Prénom");
  });
});
