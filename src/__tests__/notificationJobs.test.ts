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
vi.mock("@/lib/server-cache", () => ({
  cachedMovies: (...args: unknown[]) => mockCachedMovies(...args),
  cachedSeries: (...args: unknown[]) => mockCachedSeries(...args),
}));

const mockSendPushToAll = vi.fn();
vi.mock("@/lib/push", () => ({
  sendPushToAll: (...args: unknown[]) => mockSendPushToAll(...args),
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

    expect(mockSendPushToAll).toHaveBeenCalledWith(expect.objectContaining({ url: "/sonarr" }));
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
  it("dedupes on the timeline event id, not the series tmdb_id", async () => {
    prepareReturning([
      { id: 101, tmdb_id: 7, title: "Severance", detail: "S02E01" },
      { id: 102, tmdb_id: 7, title: "Severance", detail: "S02E02" },
    ]);
    mockAvailabilityNotifDb.hasBeenNotified.mockImplementation((_type: string, id: number) => id === 101);

    const { checkNewEpisodes } = await import("@/lib/notificationJobs");
    await checkNewEpisodes();

    // event 101 already notified -> skipped; event 102 -> notified, even though
    // both events share the same series tmdb_id.
    expect(mockSendPushToAll).toHaveBeenCalledTimes(1);
    expect(mockAvailabilityNotifDb.markNotified).toHaveBeenCalledWith("episode", 102);
  });

  it("does nothing when there are no recent imports", async () => {
    prepareReturning([]);
    const { checkNewEpisodes } = await import("@/lib/notificationJobs");
    await checkNewEpisodes();
    expect(mockSendPushToAll).not.toHaveBeenCalled();
  });
});
