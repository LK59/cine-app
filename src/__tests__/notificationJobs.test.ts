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

const mockSonarrHistory = vi.fn();
vi.mock("@/lib/clients/sonarr", () => ({
  sonarr: { getHistory: (...a: unknown[]) => mockSonarrHistory(...a) },
}));

/**
 * L'historique de Sonarr, source des imports récents.
 *
 * Ces tests fournissaient autrefois des lignes à la table `timeline_events` — que rien ne remplit
 * en production. C'est exactement pourquoi la notification pouvait passer tous ses tests et ne
 * jamais partir : le double disait ce que la vraie source ne disait pas.
 */
function importsInSonarr(records: unknown[]) {
  mockSonarrHistory.mockResolvedValue({ records });
}
const severanceImport = (over: Record<string, unknown> = {}) => ({
  id: 101,
  eventType: "downloadFolderImported",
  date: new Date(Date.now() - 10 * 60_000).toISOString(),
  series: { tmdbId: 7, title: "Severance" },
  episode: { seasonNumber: 2, episodeNumber: 1 },
  ...over,
});

function prepareReturning<T>(rows: T) {
  mockDb.prepare.mockReturnValue({ all: vi.fn().mockReturnValue(rows) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkWatchlistAvailability", () => {
  // Jusqu'au 21/09/2026 l'annonce partait à *tous* les abonnés, pour un titre de n'importe quelle
  // liste. Elle va maintenant à la personne qui l'a rangé, et une fois par personne.
  const dune = { user_id: "jf-louis", media_type: "movie", tmdb_id: 42, title: "Dune" };
  beforeEach(() => {
    mockGetUsers.mockResolvedValue([
      { Id: "jf-louis", Name: "louis" },
      { Id: "jf-arthur", Name: "arthur" },
    ]);
  });

  it("does nothing when the watchlist is empty", async () => {
    prepareReturning([]);
    const { checkWatchlistAvailability } = await import("@/lib/notificationJobs");
    await checkWatchlistAvailability();
    expect(mockCachedMovies).not.toHaveBeenCalled();
    expect(mockSendPushToUser).not.toHaveBeenCalled();
  });

  it("prévient la personne dont c'est la liste, et elle seule", async () => {
    prepareReturning([dune]);
    mockCachedMovies.mockResolvedValue([{ tmdbId: 42, hasFile: true }]);
    mockCachedSeries.mockResolvedValue([]);
    mockAvailabilityNotifDb.hasBeenNotified.mockReturnValue(false);

    const { checkWatchlistAvailability } = await import("@/lib/notificationJobs");
    await checkWatchlistAvailability();

    expect(mockSendPushToUser).toHaveBeenCalledTimes(1);
    expect(mockSendPushToUser).toHaveBeenCalledWith(
      "louis",
      expect.objectContaining({ category: "watchlist-available", tag: "watchlist-available" })
    );
    expect(mockSendPushToAll).not.toHaveBeenCalled();
    expect(mockAvailabilityNotifDb.markNotified).toHaveBeenCalledWith("watchlist:louis:movie", 42);
  });

  it("prévient chacun de ceux qui l'ont rangé, une fois chacun", async () => {
    prepareReturning([dune, { ...dune, user_id: "jf-arthur" }]);
    mockCachedMovies.mockResolvedValue([{ tmdbId: 42, hasFile: true }]);
    mockCachedSeries.mockResolvedValue([]);
    mockAvailabilityNotifDb.hasBeenNotified.mockImplementation((key: string) => key === "watchlist:louis:movie");

    const { checkWatchlistAvailability } = await import("@/lib/notificationJobs");
    await checkWatchlistAvailability();

    expect(mockSendPushToUser.mock.calls.map((c) => c[0])).toEqual(["arthur"]);
  });

  it("ne répète pas ce que l'ancienne clé commune avait déjà annoncé", async () => {
    prepareReturning([dune]);
    mockCachedMovies.mockResolvedValue([{ tmdbId: 42, hasFile: true }]);
    mockCachedSeries.mockResolvedValue([]);
    mockAvailabilityNotifDb.hasBeenNotified.mockImplementation((key: string) => key === "movie");

    const { checkWatchlistAvailability } = await import("@/lib/notificationJobs");
    await checkWatchlistAvailability();

    expect(mockSendPushToUser).not.toHaveBeenCalled();
  });

  it("skips items not yet available", async () => {
    prepareReturning([dune]);
    mockCachedMovies.mockResolvedValue([{ tmdbId: 42, hasFile: false }]);
    mockCachedSeries.mockResolvedValue([]);

    const { checkWatchlistAvailability } = await import("@/lib/notificationJobs");
    await checkWatchlistAvailability();

    expect(mockSendPushToUser).not.toHaveBeenCalled();
  });

  it("checks series availability via episodeFileCount, and links to the player", async () => {
    prepareReturning([{ user_id: "jf-louis", media_type: "series", tmdb_id: 7, title: "Severance" }]);
    mockCachedMovies.mockResolvedValue([]);
    mockCachedSeries.mockResolvedValue([{ tmdbId: 7, statistics: { episodeFileCount: 3 } }]);
    mockAvailabilityNotifDb.hasBeenNotified.mockReturnValue(false);

    const { checkWatchlistAvailability } = await import("@/lib/notificationJobs");
    await checkWatchlistAvailability();

    expect(mockSendPushToUser).toHaveBeenCalledWith("louis", expect.objectContaining({ url: "/#decouverte=7&type=series" }));
  });

  it("swallows cachedMovies/cachedSeries failures instead of throwing", async () => {
    prepareReturning([dune]);
    mockCachedMovies.mockRejectedValue(new Error("tmdb down"));
    mockCachedSeries.mockResolvedValue([]);

    const { checkWatchlistAvailability } = await import("@/lib/notificationJobs");
    await expect(checkWatchlistAvailability()).resolves.toBeUndefined();
    expect(mockSendPushToUser).not.toHaveBeenCalled();
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
    importsInSonarr([severanceImport()]);
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
    importsInSonarr([severanceImport()]);
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
    importsInSonarr([severanceImport()]);
    aSeriesEveryoneCouldFollow();
    mockGetUsers.mockResolvedValue([{ Id: "u1", Name: "louis" }]);
    mockNextUp.mockResolvedValue([]);
    mockAvailabilityNotifDb.hasBeenNotified.mockReturnValue(false);

    const { checkNewEpisodes } = await import("@/lib/notificationJobs");
    await checkNewEpisodes();
    expect(mockSendPushToUser).not.toHaveBeenCalled();
  });

  it("does nothing when there are no recent imports", async () => {
    importsInSonarr([]);
    const { checkNewEpisodes } = await import("@/lib/notificationJobs");
    await checkNewEpisodes();
    expect(mockSendPushToUser).not.toHaveBeenCalled();
    // Et n'interroge même pas Jellyfin : rien n'est arrivé, il n'y a rien à demander.
    expect(mockGetUsers).not.toHaveBeenCalled();
  });

  it("n'annonce que les imports récents, et pas les recherches", async () => {
    importsInSonarr([
      severanceImport({ id: 1, eventType: "grabbed" }),
      severanceImport({ id: 2, date: new Date(Date.now() - 5 * 3600_000).toISOString() }),
      severanceImport({ id: 3, series: { title: "Sans TMDB" } }),
    ]);
    const { recentEpisodeImports } = await import("@/lib/notificationJobs");
    expect(await recentEpisodeImports(Date.now() - 2 * 3600_000)).toEqual([]);
  });

  it("décrit l'épisode importé, clé de dédoublonnage comprise", async () => {
    importsInSonarr([severanceImport()]);
    const { recentEpisodeImports } = await import("@/lib/notificationJobs");
    expect(await recentEpisodeImports(Date.now() - 2 * 3600_000)).toEqual([
      { id: 101, tmdb_id: 7, title: "Severance", detail: "S02E01" },
    ]);
  });

  it("dit l'épisode dans la notification", async () => {
    importsInSonarr([severanceImport()]);
    aSeriesEveryoneCouldFollow();
    mockGetUsers.mockResolvedValue([{ Id: "u1", Name: "louis" }]);
    mockNextUp.mockResolvedValue([{ SeriesId: "jf-severance" }]);
    mockAvailabilityNotifDb.hasBeenNotified.mockReturnValue(false);
    const { checkNewEpisodes } = await import("@/lib/notificationJobs");
    await checkNewEpisodes();
    expect(mockSendPushToUser).toHaveBeenCalledWith(
      "louis",
      expect.objectContaining({ body: "Severance — S02E01 est disponible" })
    );
  });
});
