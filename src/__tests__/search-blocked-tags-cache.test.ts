import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// La recherche gardait sa réponse trente secondes sous une clé sans compte, et retirait les titres
// cachés (tags bloqués, DECISIONS.md §54) *dans* ce cache : le premier compte à chercher décidait
// pour tous. Un vrai cache en mémoire ici — le test de la route le remplace par un passe-plat, qui
// ne pouvait pas voir le défaut.

const sessions: Record<string, { jfId: string; role: string }> = {
  libre: { jfId: "jf-libre", role: "user" },
  bloque: { jfId: "jf-bloque", role: "user" },
};
vi.mock("@/lib/session", () => ({
  verifySessionFull: vi.fn(async (token?: string) => (token ? sessions[token] ?? null : null)),
}));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
vi.mock("@/lib/i18n", () => ({ LOCALE_COOKIE: "cine-lang", getTmdbLocale: () => "fr-FR" }));
vi.mock("@/lib/catalogueMembers", () => ({
  catalogueMembers: async () => ({ movies: [{ id: 7 }, { id: 8 }], series: [] }),
}));
vi.mock("@/lib/blockedTags", () => ({
  hiddenTmdbKeysFor: async (jfId?: string | null) => new Set(jfId === "jf-bloque" ? ["movie:42"] : []),
}));

const tmdbMock = {
  isEnabled: () => true,
  searchMulti: vi.fn(),
  searchPerson: vi.fn(),
  getPersonCredits: vi.fn(),
  movieGenres: vi.fn(async () => ({ genres: [] })),
  tvGenres: vi.fn(async () => ({ genres: [] })),
  discover: vi.fn(async () => ({ results: [] })),
  getMovie: vi.fn(),
  getTv: vi.fn(),
};
vi.mock("@/lib/clients/tmdb", () => ({
  tmdb: tmdbMock,
  createTmdbClient: () => tmdbMock,
  TMDB_IMAGE_BASE: "https://image.tmdb.org/t/p",
}));

const store = new Map<string, unknown>();
vi.mock("@/lib/server-cache", () => ({
  cachedMovies: async () => [
    { tmdbId: 42, id: 7, hasFile: true },
    { tmdbId: 43, id: 8, hasFile: true },
  ],
  cachedSeries: async () => [],
  withCache: async (key: string, _ttl: number, fn: () => Promise<unknown>) => {
    if (!store.has(key)) store.set(key, await fn());
    return store.get(key);
  },
  withPersistentCache: async (_key: string, _ttl: number, fn: () => unknown) => fn(),
  TTL: { MEDIUM: 30_000 },
}));

function req(q: string, account: string): NextRequest {
  const cookies: Record<string, string> = { cine_session: account };
  return {
    nextUrl: { searchParams: new URLSearchParams({ q }) },
    cookies: { get: (name: string) => (cookies[name] ? { value: cookies[name] } : undefined) },
  } as unknown as NextRequest;
}

beforeEach(() => {
  store.clear();
  tmdbMock.searchMulti.mockResolvedValue({
    results: [
      { id: 42, media_type: "movie", title: "Le Spectacle", popularity: 10, vote_average: 7 },
      { id: 43, media_type: "movie", title: "Le Spectacle 2", popularity: 9, vote_average: 7 },
    ],
  });
  tmdbMock.searchPerson.mockResolvedValue({
    results: [{ id: 5, name: "Un Humoriste", profile_path: "/p.jpg", known_for: [] }],
  });
  tmdbMock.getPersonCredits.mockResolvedValue({
    cast: [
      { id: 42, title: "Le Spectacle", media_type: "movie" },
      { id: 43, title: "Le Spectacle 2", media_type: "movie" },
    ],
  });
});

async function search(q: string, account: string) {
  const { GET } = await import("@/app/api/search/route");
  return (await GET(req(q, account))).json();
}

const ids = (body: { library: { tmdbId: number }[] }) => body.library.map((r) => r.tmdbId).sort();

describe("GET /api/search — tags bloqués et cache commun", () => {
  it("un compte bloqué ne reçoit pas ce qu'un compte libre a mis en cache", async () => {
    expect(ids(await search("le spectacle", "libre"))).toEqual([42, 43]);
    expect(ids(await search("le spectacle", "bloque"))).toEqual([43]);
  });

  it("un compte libre ne perd pas ce qu'un compte bloqué a mis en cache", async () => {
    await search("le spectacle", "bloque");
    expect(ids(await search("le spectacle", "libre"))).toEqual([42, 43]);
  });

  // « Une personne reste trouvable ; ses titres cachés, non » : la carte disait « 2 titres ici » et
  // nommait le titre caché.
  it("la carte d'une personne ne compte ni ne nomme un titre caché", async () => {
    const bloque = await search("un humoriste", "bloque");
    expect(bloque.persons[0]).toMatchObject({ libraryCount: 1, libraryTitles: ["Le Spectacle 2"] });
    const libre = await search("un humoriste", "libre");
    expect(libre.persons[0]).toMatchObject({ libraryCount: 2 });
  });
});
