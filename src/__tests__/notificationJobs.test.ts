import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAvailabilityNotifDb = {
  hasBeenNotified: vi.fn(),
  markNotified: vi.fn(),
  cleanup: vi.fn(),
};
const mockKvCacheDb = { cleanup: vi.fn() };
const mockDb = { prepare: vi.fn() };
vi.mock("@/lib/db", () => ({
  availabilityNotifDb: mockAvailabilityNotifDb,
  kvCacheDb: mockKvCacheDb,
  getDb: () => mockDb,
}));

const mockCachedMovies = vi.fn();
const mockCachedSeries = vi.fn();
const mockCachedJellyfinSeries = vi.fn(async () => [] as unknown[]);
vi.mock("@/lib/server-cache", () => ({
  cachedMovies: (...args: unknown[]) => mockCachedMovies(...args),
  cachedSeries: (...args: unknown[]) => mockCachedSeries(...args),
  cachedJellyfinSeriesAdmin: (...args: unknown[]) => mockCachedJellyfinSeries(...(args as [])),
  // L'appariement TVDB→Jellyfin est testé chez lui : ici on lui fait rendre la série qu'on veut.
  findJellyfinSeriesByTvdb: (items: { Id: string }[]) => items[0] ?? null,
}));

const mockGetUsers = vi.fn();
const mockNextUp = vi.fn();
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getUsers: (...a: unknown[]) => mockGetUsers(...a),
    getNextUpGlobal: (...a: unknown[]) => mockNextUp(...a),
  },
}));

const mockSendPushToAll = vi.fn();
const mockSendPushToUser = vi.fn();
vi.mock("@/lib/push", () => ({
  sendPushToAll: (...args: unknown[]) => mockSendPushToAll(...args),
  sendPushToUser: (...args: unknown[]) => mockSendPushToUser(...args),
}));

vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

function prepareReturning<T>(rows: T) {
  mockDb.prepare.mockReturnValue({ all: vi.fn().mockReturnValue(rows) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkWatchlistAvailability", () => {
  it("does nothing when the watchlist is empty", async () => {
    prepareReturning([]);
    const { checkWatchlistAvailability } = await import("@/lib/notificationJobs");
    await checkWatchlistAvailability();
    expect(mockCachedMovies).not.toHaveBeenCalled();
    expect(mockSendPushToAll).not.toHaveBeenCalled();
  });

  it("notifies for a movie that became available and is not yet notified", async () => {
    prepareReturning([{ media_type: "movie", tmdb_id: 42, title: "Dune" }]);
    mockCachedMovies.mockResolvedValue([{ tmdbId: 42, hasFile: true }]);
    mockCachedSeries.mockResolvedValue([]);
    mockAvailabilityNotifDb.hasBeenNotified.mockReturnValue(false);

    const { checkWatchlistAvailability } = await import("@/lib/notificationJobs");
    await checkWatchlistAvailability();

    expect(mockSendPushToAll).toHaveBeenCalledWith(
      expect.objectContaining({ category: "watchlist-available", tag: "watchlist-available" })
    );
    expect(mockAvailabilityNotifDb.markNotified).toHaveBeenCalledWith("movie", 42);
  });

  it("skips items already notified", async () => {
    prepareReturning([{ media_type: "movie", tmdb_id: 42, title: "Dune" }]);
    mockCachedMovies.mockResolvedValue([{ tmdbId: 42, hasFile: true }]);
    mockCachedSeries.mockResolvedValue([]);
    mockAvailabilityNotifDb.hasBeenNotified.mockReturnValue(true);

    const { checkWatchlistAvailability } = await import("@/lib/notificationJobs");
    await checkWatchlistAvailability();

    expect(mockSendPushToAll).not.toHaveBeenCalled();
  });

  it("skips items not yet available", async () => {
    prepareReturning([{ media_type: "movie", tmdb_id: 42, title: "Dune" }]);
    mockCachedMovies.mockResolvedValue([{ tmdbId: 42, hasFile: false }]);
    mockCachedSeries.mockResolvedValue([]);

    const { checkWatchlistAvailability } = await import("@/lib/notificationJobs");
    await checkWatchlistAvailability();

    expect(mockSendPushToAll).not.toHaveBeenCalled();
  });

  it("checks series availability via episodeFileCount", async () => {
    prepareReturning([{ media_type: "series", tmdb_id: 7, title: "Severance" }]);
    mockCachedMovies.mockResolvedValue([]);
    mockCachedSeries.mockResolvedValue([{ tmdbId: 7, statistics: { episodeFileCount: 3 } }]);
    mockAvailabilityNotifDb.hasBeenNotified.mockReturnValue(false);

    const { checkWatchlistAvailability } = await import("@/lib/notificationJobs");
    await checkWatchlistAvailability();

    // La notification mène au lecteur, sur la fiche du titre : elle s'adresse à quelqu'un à qui
    // on annonce qu'une série est arrivée, pas à quelqu'un qui vient administrer Sonarr.
    expect(mockSendPushToAll).toHaveBeenCalledWith(
      expect.objectContaining({ url: "/#decouverte=7&type=series" })
    );
  });

  it("swallows cachedMovies/cachedSeries failures instead of throwing", async () => {
    prepareReturning([{ media_type: "movie", tmdb_id: 42, title: "Dune" }]);
    mockCachedMovies.mockRejectedValue(new Error("tmdb down"));
    mockCachedSeries.mockResolvedValue([]);

    const { checkWatchlistAvailability } = await import("@/lib/notificationJobs");
    await expect(checkWatchlistAvailability()).resolves.toBeUndefined();
    expect(mockSendPushToAll).not.toHaveBeenCalled();
  });
});

describe("checkNewEpisodes", () => {
  function aSeriesEveryoneCouldFollow() {
    mockCachedSeries.mockResolvedValue([{ tmdbId: 7, tvdbId: 700, title: "Severance", year: 2022 }]);
    mockCachedJellyfinSeries.mockResolvedValue([{ Id: "jf-severance" }]);
  }

  // Le fond de la correction : la tâche poussait vers tout le monde à chaque import. Une
  // notification qu'on n'attendait pas est une notification qu'on finit par couper, emportant
  // avec elle celles qui comptaient.
  it("tells only the people who were waiting for that episode", async () => {
    prepareReturning([{ id: 101, tmdb_id: 7, title: "Severance", detail: "S02E01" }]);
    aSeriesEveryoneCouldFollow();
    mockGetUsers.mockResolvedValue([
      { Id: "u1", Name: "louis" },
      { Id: "u2", Name: "arthur" },
    ]);
    mockNextUp.mockImplementation(async (userId: string) =>
      userId === "u1" ? [{ SeriesId: "jf-severance" }] : [{ SeriesId: "jf-autre-chose" }]
    );
    mockAvailabilityNotifDb.hasBeenNotified.mockReturnValue(false);

    const { checkNewEpisodes } = await import("@/lib/notificationJobs");
    await checkNewEpisodes();

    expect(mockSendPushToUser).toHaveBeenCalledTimes(1);
    expect(mockSendPushToUser).toHaveBeenCalledWith("louis", expect.objectContaining({ category: "new-episode" }));
    // Et plus jamais vers tout le monde.
    expect(mockSendPushToAll).not.toHaveBeenCalled();
  });

  // Le dédoublonnage est devenu par personne : le même épisode s'annonce à plusieurs comptes, et
  // une seule fois à chacun. Une clé globale faisait taire tous les autres dès le premier averti.
  it("dedupes per person rather than per episode", async () => {
    prepareReturning([{ id: 101, tmdb_id: 7, title: "Severance", detail: "S02E01" }]);
    aSeriesEveryoneCouldFollow();
    mockGetUsers.mockResolvedValue([
      { Id: "u1", Name: "louis" },
      { Id: "u2", Name: "arthur" },
    ]);
    mockNextUp.mockResolvedValue([{ SeriesId: "jf-severance" }]);
    mockAvailabilityNotifDb.hasBeenNotified.mockImplementation((kind: string) => kind === "episode:louis");

    const { checkNewEpisodes } = await import("@/lib/notificationJobs");
    await checkNewEpisodes();

    expect(mockSendPushToUser).toHaveBeenCalledTimes(1);
    expect(mockSendPushToUser).toHaveBeenCalledWith("arthur", expect.anything());
    expect(mockAvailabilityNotifDb.markNotified).toHaveBeenCalledWith("episode:arthur", 101);
  });

  it("says nothing about a series nobody has started", async () => {
    prepareReturning([{ id: 101, tmdb_id: 7, title: "Severance", detail: "S02E01" }]);
    aSeriesEveryoneCouldFollow();
    mockGetUsers.mockResolvedValue([{ Id: "u1", Name: "louis" }]);
    mockNextUp.mockResolvedValue([]);
    mockAvailabilityNotifDb.hasBeenNotified.mockReturnValue(false);

    const { checkNewEpisodes } = await import("@/lib/notificationJobs");
    await checkNewEpisodes();
    expect(mockSendPushToUser).not.toHaveBeenCalled();
  });

  it("does nothing when there are no recent imports", async () => {
    prepareReturning([]);
    const { checkNewEpisodes } = await import("@/lib/notificationJobs");
    await checkNewEpisodes();
    expect(mockSendPushToUser).not.toHaveBeenCalled();
    // Et n'interroge même pas Jellyfin : rien n'est arrivé, il n'y a rien à demander.
    expect(mockGetUsers).not.toHaveBeenCalled();
  });
});
