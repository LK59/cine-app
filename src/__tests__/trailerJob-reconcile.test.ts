import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetLatestJob = vi.fn();
const mockFinishJob = vi.fn();
vi.mock("@/lib/db", () => ({
  trailerDb: {
    getLatestJob: (...a: unknown[]) => mockGetLatestJob(...a),
    finishJob: (...a: unknown[]) => mockFinishJob(...a),
  },
}));
vi.mock("@/lib/server-cache", () => ({ cachedMovies: vi.fn(), cachedSeries: vi.fn() }));
vi.mock("@/lib/clients/tmdb", () => ({ tmdb: { isEnabled: () => false, getMovieVideos: vi.fn(), getTvVideos: vi.fn() } }));
vi.mock("@/lib/trailerDownload", () => ({
  downloadTrailer: vi.fn(),
  getLocalTrailerPath: vi.fn(),
  killActiveDownloads: vi.fn(),
  DOWNLOAD_CONCURRENCY: 3,
}));

beforeEach(() => vi.clearAllMocks());

describe("reconcileStaleTrailerJobs", () => {
  it("marks a job stuck at 'running' (a killed process never got to finish it) as errored", async () => {
    mockGetLatestJob.mockReturnValue({ id: 7, status: "running" });
    const { reconcileStaleTrailerJobs } = await import("@/lib/trailerJob");
    reconcileStaleTrailerJobs();
    expect(mockFinishJob).toHaveBeenCalledWith(7, "error");
  });

  it("leaves a done/error job alone", async () => {
    mockGetLatestJob.mockReturnValue({ id: 7, status: "done" });
    const { reconcileStaleTrailerJobs } = await import("@/lib/trailerJob");
    reconcileStaleTrailerJobs();
    expect(mockFinishJob).not.toHaveBeenCalled();
  });

  it("does nothing when no job has ever run", async () => {
    mockGetLatestJob.mockReturnValue(null);
    const { reconcileStaleTrailerJobs } = await import("@/lib/trailerJob");
    reconcileStaleTrailerJobs();
    expect(mockFinishJob).not.toHaveBeenCalled();
  });
});
