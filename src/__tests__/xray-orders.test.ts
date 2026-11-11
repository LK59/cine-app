import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Commander l'analyse des acteurs à l'écran (DECISIONS.md §138) : la commande construite depuis
 * Jellyfin et TMDB (chemin, version, série, distribution de l'épisode invités compris, plusieurs
 * photos), une commande par élément, l'épisode suivant derrière, et jamais une erreur qui sorte.
 */

const MOVIE = "a".repeat(32);
const SERIES = "b".repeat(32);
const EP1 = "c".repeat(32);
const EP2 = "d".repeat(32);
const SPECIAL = "e".repeat(32);

const state = vi.hoisted(() => ({ configured: true, enqueued: [] as unknown[], enqueueError: null as Error | null, done: false }));
vi.mock("@/lib/clients/xray", () => ({
  xrayConfigured: () => state.configured,
  xray: {
    enqueue: async (job: { itemId: string }) => {
      if (state.enqueueError) throw state.enqueueError;
      state.enqueued.push(job);
      return { itemId: job.itemId, status: state.done ? "done" : "queued", position: state.enqueued.length };
    },
  },
}));

vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getItemForAnalysis: async (id: string) => {
      if (id === MOVIE) return { Id: MOVIE, Type: "Movie", Path: "/media/movies/F.mkv", ProviderIds: { Tmdb: "603" }, MediaSources: [{ Path: "/media/movies/F.mkv", ETag: "etag-film", Size: 10 }] };
      if (id === SERIES) return { Id: SERIES, Type: "Series", ProviderIds: { Tmdb: "1781" } };
      if (id === EP1) return { Id: EP1, Type: "Episode", SeriesId: SERIES, ParentIndexNumber: 2, IndexNumber: 5, MediaSources: [{ Path: "/media/tv/S/S02E05.mkv", Size: 42 }] };
      if (id === EP2) return { Id: EP2, Type: "Episode", SeriesId: SERIES, ParentIndexNumber: 2, IndexNumber: 6, MediaSources: [{ Path: "/media/tv/S/S02E06.mkv", ETag: "etag-6" }] };
      return null;
    },
    getEpisodesAdmin: async () => [
      { Id: SPECIAL, ParentIndexNumber: 0, IndexNumber: 1 },
      { Id: EP2, ParentIndexNumber: 2, IndexNumber: 6 },
      { Id: EP1, ParentIndexNumber: 2, IndexNumber: 5 },
    ],
  },
}));

const person = (id: number, order: number, character = `Rôle ${id}`) => ({ id, name: `Acteur ${id}`, character, order, profile_path: `/p${id}.jpg` });
const tmdbCalls: string[] = [];
vi.mock("@/lib/clients/tmdb", () => ({
  TMDB_IMAGE_BASE: "https://image.tmdb.org/t/p",
  tmdb: {
    getMovieCredits: async (id: number) => {
      tmdbCalls.push(`movie:${id}`);
      return { cast: Array.from({ length: 60 }, (_, i) => person(1000 + i, 59 - i)) };
    },
    getEpisodeCredits: async (tv: number, s: number, e: number) => {
      tmdbCalls.push(`episode:${tv}:${s}:${e}`);
      return { cast: [person(2, 1), person(1, 0)], guest_stars: [person(3, 0, "Invité"), person(1, 5, "Double")] };
    },
    getPersonImages: async (id: number) => {
      tmdbCalls.push(`images:${id}`);
      if (id === 3) throw new Error("TMDB muet");
      return { profiles: Array.from({ length: 12 }, (_, i) => ({ file_path: `/alt${id}-${i}.jpg`, vote_average: i, width: 1, height: 1 })) };
    },
    findTvByTvdbId: async () => ({ tv_results: [] }),
  },
}));

vi.mock("@/lib/server-cache", () => ({
  withCache: (_k: string, _t: number, fn: () => Promise<unknown>) => fn(),
  withPersistentCache: (_k: string, _t: number, fn: () => Promise<unknown>) => fn(),
  getProviderIdCI: (ids: Record<string, string> | undefined, key: string) => ids?.[key],
}));
const mockLogError = vi.fn();
vi.mock("@/lib/logger", () => ({ logError: (...a: unknown[]) => mockLogError(...a) }));
const mockTaskLog = vi.fn();
vi.mock("@/lib/taskLog", () => ({ taskLog: (...a: unknown[]) => mockTaskLog(...a) }));

beforeEach(async () => {
  vi.clearAllMocks();
  Object.assign(state, { configured: true, enqueued: [], enqueueError: null, done: false });
  tmdbCalls.length = 0;
  (await import("@/lib/xray/orders")).forgetXrayOrders();
});

type Job = { itemId: string; path: string; etag: string; priority: string; startAt?: number; seriesId: string | null; cast: { personId: number; character: string; photos: string[] }[] };

describe("la commande d'un élément", () => {
  it("un épisode : son fichier, sa version, sa série, et sa distribution invités compris", async () => {
    const { orderAnalysis } = await import("@/lib/xray/orders");
    const outcome = await orderAnalysis(EP1, { priority: "high", startAt: 750.12345 });
    expect(outcome).toMatchObject({ status: "ordered", cast: 3 });
    const job = state.enqueued[0] as Job;
    expect(job).toMatchObject({ itemId: EP1, path: "/media/tv/S/S02E05.mkv", etag: "size:42", priority: "high", startAt: 750.123, seriesId: SERIES });
    expect(tmdbCalls).toContain("episode:1781:2:5");
    // L'ordre du générique, puis les invités ; une personne créditée deux fois garde ses deux rôles.
    expect(job.cast.map((c) => [c.personId, c.character])).toEqual([[1, "Rôle 1 / Double"], [2, "Rôle 2"], [3, "Invité"]]);
    // La photo principale d'abord, huit au plus, toutes chez image.tmdb.org.
    expect(job.cast[0].photos).toHaveLength(8);
    expect(job.cast[0].photos[0]).toBe("https://image.tmdb.org/t/p/w185/p1.jpg");
    expect(job.cast.flatMap((c) => c.photos).every((u) => u.startsWith("https://image.tmdb.org/t/p/w185/"))).toBe(true);
    // Un album qui ne répond pas garde la photo principale.
    expect(job.cast[2].photos).toEqual(["https://image.tmdb.org/t/p/w185/p3.jpg"]);
    expect(mockTaskLog).toHaveBeenCalledTimes(1);
    expect(mockTaskLog.mock.calls[0][0]).toBe("acteurs");
  });

  it("un film : sa distribution dans l'ordre, quarante au plus, sans série", async () => {
    const { orderAnalysis } = await import("@/lib/xray/orders");
    await orderAnalysis(MOVIE, { priority: "normal" });
    const job = state.enqueued[0] as Job;
    expect(job).toMatchObject({ etag: "etag-film", seriesId: null, priority: "normal" });
    expect(job.startAt).toBeUndefined();
    expect(job.cast).toHaveLength(40);
    expect(job.cast[0].personId).toBe(1059);
  });

  it("une commande par élément ; une priorité plus haute repasse", async () => {
    const { orderAnalysis } = await import("@/lib/xray/orders");
    expect((await orderAnalysis(MOVIE, { priority: "normal" })).status).toBe("ordered");
    expect(await orderAnalysis(MOVIE, { priority: "normal" })).toEqual({ status: "skipped", reason: "recent" });
    expect(await orderAnalysis(MOVIE, { priority: "low" })).toEqual({ status: "skipped", reason: "recent" });
    expect((await orderAnalysis(MOVIE, { priority: "high" })).status).toBe("ordered");
    expect((await orderAnalysis(MOVIE, { priority: "high", force: true })).status).toBe("ordered");
    expect(state.enqueued).toHaveLength(3);
  });

  it("ne fait rien option coupée", async () => {
    state.configured = false;
    const { orderAnalysis } = await import("@/lib/xray/orders");
    expect(await orderAnalysis(MOVIE, { priority: "high" })).toEqual({ status: "off" });
    expect(tmdbCalls).toEqual([]);
  });

  it("un élément inconnu ou sans distribution n'est pas commandé", async () => {
    const { orderAnalysis } = await import("@/lib/xray/orders");
    expect(await orderAnalysis("f".repeat(32), { priority: "high" })).toEqual({ status: "unavailable", reason: "no-file" });
    expect(state.enqueued).toEqual([]);
  });

  it("un service en panne : l'échec est rendu et journalisé, jamais levé", async () => {
    state.enqueueError = new Error("ECONNREFUSED");
    const { orderAnalysis } = await import("@/lib/xray/orders");
    expect(await orderAnalysis(MOVIE, { priority: "high" })).toMatchObject({ status: "failed" });
    expect(mockLogError).toHaveBeenCalledWith("xray/order", expect.any(Error), expect.objectContaining({ itemId: MOVIE }));
    expect(mockTaskLog).not.toHaveBeenCalled();
    // Retentée plus tard, pas à la ligne suivante.
    state.enqueueError = null;
    expect(await orderAnalysis(MOVIE, { priority: "high" })).toEqual({ status: "skipped", reason: "recent" });
    expect((await orderAnalysis(MOVIE, { priority: "high" }, Date.now() + 11 * 60_000)).status).toBe("ordered");
  });

  it("« déjà fait » au même fichier n'écrit pas de ligne de tâche", async () => {
    state.done = true;
    const { orderAnalysis } = await import("@/lib/xray/orders");
    expect((await orderAnalysis(MOVIE, { priority: "high" })).status).toBe("ordered");
    expect(mockTaskLog).not.toHaveBeenCalled();
  });

  it("ni un fichier hors des dossiers permis, ni l'animation écartée par le plan — sauf commande forcée (11/11/2026)", async () => {
    const { orderAnalysis } = await import("@/lib/xray/orders");
    const { getDb } = await import("@/lib/db");
    (await import("@/lib/xray/scanStore")).planSize(); // la table, créée à la première lecture
    getDb()
      .prepare("INSERT OR REPLACE INTO xray_scan_items (item_id, tier, kind, title, status, reason) VALUES (?, 3, 'Movie', 'Animé', 'excluded', 'animation')")
      .run(MOVIE);
    try {
      expect(await orderAnalysis(MOVIE, { priority: "high" })).toEqual({ status: "unavailable", reason: "animation" });
      expect(state.enqueued).toEqual([]);
      expect((await orderAnalysis(MOVIE, { priority: "high", force: true })).status).toBe("ordered");
    } finally {
      getDb().prepare("DELETE FROM xray_scan_items WHERE item_id = ?").run(MOVIE);
    }
  });

  it("un épisode déjà commandé n'entraîne pas une relecture de la série à chaque ligne `start`", async () => {
    const { noteSessionStart } = await import("@/lib/xray/orders");
    noteSessionStart(EP1, 10, "louis");
    await vi.waitFor(() => expect(state.enqueued).toHaveLength(2));
    noteSessionStart(EP1, 20, "louis");
    await new Promise((r) => setTimeout(r, 20));
    expect(state.enqueued).toHaveLength(2);
  });

  it("borne les commandes neuves d'un compte", async () => {
    const { orderAnalysis } = await import("@/lib/xray/orders");
    const ids = Array.from({ length: 31 }, (_, i) => i.toString(16).padStart(32, "0"));
    const outcomes = [];
    for (const id of ids) outcomes.push(await orderAnalysis(id, { priority: "high", account: "boucle" }));
    expect(outcomes.at(-1)).toEqual({ status: "skipped", reason: "limit" });
  });
});

describe("une séance qui commence", () => {
  it("commande l'épisode regardé en high à la position, puis le suivant en normal", async () => {
    const { noteSessionStart } = await import("@/lib/xray/orders");
    noteSessionStart(EP1, 321.5, "louis");
    await vi.waitFor(() => expect(state.enqueued).toHaveLength(2));
    const [first, second] = state.enqueued as Job[];
    expect(first).toMatchObject({ itemId: EP1, priority: "high", startAt: 321.5 });
    expect(second).toMatchObject({ itemId: EP2, priority: "normal", etag: "etag-6" });
    expect(second.startAt).toBeUndefined();
  });

  it("ne lève jamais, même sur un élément invalide ou une option coupée", async () => {
    const { noteSessionStart } = await import("@/lib/xray/orders");
    expect(() => noteSessionStart("../../Users", 0, "x")).not.toThrow();
    state.configured = false;
    expect(() => noteSessionStart(EP1, 10, "x")).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(state.enqueued).toEqual([]);
  });
});

describe("l'épisode suivant", () => {
  it("suit les saisons, garde les spéciaux entre eux, et s'arrête au dernier", async () => {
    const { nextEpisodeAfter } = await import("@/lib/xray/cast");
    const list = [
      { Id: "1".repeat(32), ParentIndexNumber: 1, IndexNumber: 2 },
      { Id: "2".repeat(32), ParentIndexNumber: 2, IndexNumber: 1 },
      { Id: "3".repeat(32), ParentIndexNumber: 0, IndexNumber: 1 },
      { Id: "4".repeat(32), ParentIndexNumber: 0, IndexNumber: 2 },
      { Id: "5".repeat(32), ParentIndexNumber: 1, IndexNumber: 1 },
    ];
    expect(nextEpisodeAfter(list, "5".repeat(32))).toBe("1".repeat(32));
    expect(nextEpisodeAfter(list, "1".repeat(32))).toBe("2".repeat(32));
    expect(nextEpisodeAfter(list, "2".repeat(32))).toBeNull();
    expect(nextEpisodeAfter(list, "3".repeat(32))).toBe("4".repeat(32));
    expect(nextEpisodeAfter(list, "9".repeat(32))).toBeNull();
  });
});
