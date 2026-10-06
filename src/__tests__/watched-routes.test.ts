import { describe, it, expect, vi, beforeEach } from "vitest";

/** Les routes du « vu » (DECISIONS.md §51) : marquer, et ce que la fin d'une lecture a achevé. */
const s = vi.hoisted(() => ({
  session: { u: "emma", jfId: "jf-emma", role: "user" } as Record<string, unknown> | null,
  setWatched: vi.fn(async () => ({ watched: true })),
  index: { movies: new Map(), series: new Map(), byJellyfinId: new Map([["s-lasso", { type: "series", tmdbId: 97546 }]]) },
  item: {} as Record<string, unknown>,
  episodes: [] as Record<string, unknown>[],
  inList: true,
  upserts: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "c" }));
vi.mock("@/lib/session", () => ({ verifySessionFull: async () => s.session }));
vi.mock("@/lib/watched", () => ({ setWatched: s.setWatched, libraryIndex: async () => s.index }));
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: { getItemBasic: async () => s.item, getSeriesEpisodes: async () => s.episodes },
}));
vi.mock("@/lib/db", () => ({
  watchedDb: { get: () => null, upsert: (r: Record<string, unknown>) => void s.upserts.push(r) },
  watchlistDb: { get: () => (s.inList ? { id: 1 } : null) },
}));
vi.mock("@/lib/server-cache", () => ({ getProviderIdCI: (ids: Record<string, string> | undefined) => ids?.Tmdb }));

import { POST } from "@/app/api/player/watched/route";
import { GET as FINISHED } from "@/app/api/player/watched/finished/route";

const post = (body: unknown) => ({ cookies: { get: () => ({ value: "t" }) }, json: async () => body }) as never;
const get = (itemId: string) => ({ cookies: { get: () => ({ value: "t" }) }, nextUrl: new URL(`http://x/api/player/watched/finished?itemId=${itemId}`) }) as never;
const JF = (n: number) => String(n).padStart(32, "0");

beforeEach(() => {
  s.session = { u: "emma", jfId: "jf-emma", role: "user" };
  s.setWatched.mockClear();
  s.upserts = [];
  s.inList = true;
});

describe("POST /api/player/watched", () => {
  it("marque un titre désigné par TMDB, pour l'appelant seulement", async () => {
    const res = await POST(post({ type: "movie", tmdbId: 603, watched: true, title: "Matrix" }));
    expect(res.status).toBe(200);
    expect(s.setWatched).toHaveBeenCalledWith({ userId: "jf-emma", jfId: "jf-emma" }, "movie", 603, true, expect.objectContaining({ title: "Matrix" }));
  });

  it("retrouve le titre d'un élément de la bibliothèque (une série, depuis sa fiche)", async () => {
    s.index.byJellyfinId.set(JF(7), { type: "series", tmdbId: 97546 });
    await POST(post({ itemId: JF(7), watched: true }));
    expect(s.setWatched).toHaveBeenCalledWith(expect.anything(), "series", 97546, true, expect.anything());
  });

  it("refuse sans session, sans état, ou un titre introuvable", async () => {
    expect((await POST(post({ type: "movie", tmdbId: 1 }))).status).toBe(400);
    expect((await POST(post({ itemId: JF(99), watched: true }))).status).toBe(404);
    s.session = null;
    expect((await POST(post({ type: "movie", tmdbId: 1, watched: true }))).status).toBe(401);
  });
});

describe("GET /api/player/watched/finished", () => {
  it("un film fini : il entre dans « Vu », et la réponse dit qu'il est encore dans « À voir »", async () => {
    s.item = { Id: JF(1), Type: "Movie", Name: "Dune", ProviderIds: { Tmdb: "438631" } };
    const body = await (await FINISHED(get(JF(1)))).json();
    expect(body).toMatchObject({ finished: true, type: "movie", tmdbId: 438631, inToWatch: true });
    expect(s.upserts[0]).toMatchObject({ mediaType: "movie", tmdbId: 438631, jfPlayed: true });
  });

  it("le dernier épisode à voir d'une série : la série est finie", async () => {
    s.item = { Id: JF(2), Type: "Episode", Name: "Fin", SeriesId: "s-lasso", SeriesName: "Ted Lasso" };
    s.episodes = [{ Id: JF(3), UserData: { Played: true } }, { Id: JF(2), UserData: { Played: false } }];
    const body = await (await FINISHED(get(JF(2)))).json();
    expect(body).toMatchObject({ finished: true, type: "series", tmdbId: 97546, title: "Ted Lasso" });
  });

  it("un épisode alors qu'il en reste d'autres : rien n'est fini, rien n'est écrit", async () => {
    s.item = { Id: JF(2), Type: "Episode", SeriesId: "s-lasso" };
    s.episodes = [{ Id: JF(4), UserData: { Played: false } }, { Id: JF(2), UserData: { Played: false } }];
    expect(await (await FINISHED(get(JF(2)))).json()).toEqual({ finished: false });
    expect(s.upserts).toEqual([]);
  });
});
