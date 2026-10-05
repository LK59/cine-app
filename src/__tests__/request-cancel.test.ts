import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Annuler une demande (DECISIONS.md §49) : chacun retire la sienne ; restée sans suite, elle sort
 * aussi de Radarr ou Sonarr ; en cours, déjà là, demandée par un autre ou ajoutée avant elle, seule
 * la demande disparaît.
 */
const { jellyseerr, radarr, sonarr, invalidateLibrary } = vi.hoisted(() => ({
  jellyseerr: {
    getRequest: vi.fn(),
    deleteRequest: vi.fn(async (_id: number) => undefined),
    deleteMedia: vi.fn(async (_id: number) => undefined),
    getMovieMedia: vi.fn(),
    getTvMedia: vi.fn(),
  },
  radarr: { getMovie: vi.fn(), getQueue: vi.fn(), deleteMovie: vi.fn(async (_id: number) => undefined) },
  sonarr: { getSeriesById: vi.fn(), getQueue: vi.fn(), deleteSeries: vi.fn(async (_id: number) => undefined) },
  invalidateLibrary: vi.fn(),
}));
vi.mock("@/lib/clients/jellyseerr", () => ({ jellyseerr }));
vi.mock("@/lib/clients/radarr", () => ({ radarr }));
vi.mock("@/lib/clients/sonarr", () => ({ sonarr }));
vi.mock("@/lib/server-cache", () => ({ invalidateLibrary: () => invalidateLibrary() }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

import { cancelRequest } from "@/lib/requestCancel";

const REQUESTED_AT = "2026-10-01T10:00:00.000Z";
const movieRequest = (over: Record<string, unknown> = {}) => ({
  id: 7,
  type: "movie",
  createdAt: REQUESTED_AT,
  requestedBy: { id: 23 },
  media: { id: 90, tmdbId: 603, mediaType: "movie", externalServiceId: 55 },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  jellyseerr.getRequest.mockResolvedValue(movieRequest());
  jellyseerr.getMovieMedia.mockResolvedValue({ mediaInfo: { id: 90, status: 3, requests: [{ id: 7 }] } });
  jellyseerr.getTvMedia.mockResolvedValue({ mediaInfo: { id: 91, status: 3, requests: [{ id: 8 }] } });
  radarr.getMovie.mockResolvedValue({ id: 55, hasFile: false, added: "2026-10-01T10:00:02.000Z" });
  radarr.getQueue.mockResolvedValue({ records: [] });
  sonarr.getSeriesById.mockResolvedValue({ id: 66, statistics: { episodeFileCount: 0 }, added: "2026-10-01T10:00:02.000Z" });
  sonarr.getQueue.mockResolvedValue({ records: [] });
});

describe("annuler une demande", () => {
  it("refuse la demande de quelqu'un d'autre, sans rien toucher", async () => {
    expect(await cancelRequest(7, { userId: 99, admin: false })).toEqual({ ok: false, status: 404 });
    expect(await cancelRequest(7, { userId: null, admin: false })).toEqual({ ok: false, status: 404 });
    expect(jellyseerr.deleteRequest).not.toHaveBeenCalled();
  });

  it("restée sans suite : la retire, et sort le film de Radarr (sans fichier) et de Jellyseerr", async () => {
    expect(await cancelRequest(7, { userId: 23, admin: false })).toEqual({ ok: true, removedFromLibrary: true });
    // Avec la clé d'API, après vérification : Jellyseerr refuse à un compte ordinaire une demande approuvée.
    expect(jellyseerr.deleteRequest).toHaveBeenCalledWith(7);
    expect(radarr.deleteMovie).toHaveBeenCalledWith(55);
    expect(jellyseerr.deleteMedia).toHaveBeenCalledWith(90);
    expect(invalidateLibrary).toHaveBeenCalled();
  });

  it("déjà là : seule la demande disparaît", async () => {
    radarr.getMovie.mockResolvedValue({ id: 55, hasFile: true, added: "2026-10-01T10:00:02.000Z" });
    expect(await cancelRequest(7, { userId: 23, admin: false })).toEqual({ ok: true, removedFromLibrary: false });
    expect(jellyseerr.deleteRequest).toHaveBeenCalledWith(7);
    expect(radarr.deleteMovie).not.toHaveBeenCalled();
    expect(jellyseerr.deleteMedia).not.toHaveBeenCalled();
  });

  it("en téléchargement : seule la demande disparaît", async () => {
    radarr.getQueue.mockResolvedValue({ records: [{ movieId: 55 }] });
    await cancelRequest(7, { userId: 23, admin: false });
    expect(radarr.deleteMovie).not.toHaveBeenCalled();
  });

  it("demandée aussi par quelqu'un d'autre : le film reste dans Radarr", async () => {
    jellyseerr.getMovieMedia.mockResolvedValue({ mediaInfo: { id: 90, status: 3, requests: [{ id: 7 }, { id: 12 }] } });
    await cancelRequest(7, { userId: 23, admin: false });
    expect(jellyseerr.deleteRequest).toHaveBeenCalledWith(7);
    expect(radarr.deleteMovie).not.toHaveBeenCalled();
  });

  it("déjà dans Radarr avant la demande (ajouté à la main) : il y reste", async () => {
    radarr.getMovie.mockResolvedValue({ id: 55, hasFile: false, added: "2026-09-01T00:00:00.000Z" });
    await cancelRequest(7, { userId: 23, admin: false });
    expect(radarr.deleteMovie).not.toHaveBeenCalled();
  });

  it("une série sans aucun épisode : retirée de Sonarr ; avec un épisode, elle reste", async () => {
    jellyseerr.getRequest.mockResolvedValue(movieRequest({ id: 8, type: "tv", media: { id: 91, tmdbId: 1399, mediaType: "tv", externalServiceId: 66 } }));
    expect(await cancelRequest(8, { userId: 23, admin: false })).toEqual({ ok: true, removedFromLibrary: true });
    expect(sonarr.deleteSeries).toHaveBeenCalledWith(66);
    expect(jellyseerr.deleteMedia).toHaveBeenCalledWith(91);

    vi.clearAllMocks();
    sonarr.getSeriesById.mockResolvedValue({ id: 66, statistics: { episodeFileCount: 3 }, added: "2026-10-01T10:00:02.000Z" });
    sonarr.getQueue.mockResolvedValue({ records: [] });
    await cancelRequest(8, { userId: 23, admin: false });
    expect(sonarr.deleteSeries).not.toHaveBeenCalled();
  });

  it("une vérification qui échoue n'empêche pas l'annulation, et ne touche pas à Radarr", async () => {
    radarr.getMovie.mockRejectedValue(new Error("Radarr injoignable"));
    expect(await cancelRequest(7, { userId: 23, admin: false })).toEqual({ ok: true, removedFromLibrary: false });
    expect(jellyseerr.deleteRequest).toHaveBeenCalledWith(7);
    expect(radarr.deleteMovie).not.toHaveBeenCalled();
  });

  it("l'administrateur peut retirer celle d'un autre, avec la même règle", async () => {
    expect(await cancelRequest(7, { userId: 1, admin: true })).toEqual({ ok: true, removedFromLibrary: true });
  });
});
