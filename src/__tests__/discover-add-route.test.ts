import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockRadarr = {
  lookupMovie: vi.fn(),
  getQualityProfiles: vi.fn(),
  getRootFolders: vi.fn(),
  addMovie: vi.fn(),
};
const mockSonarr = {
  lookupSeries: vi.fn(),
  getQualityProfiles: vi.fn(),
  getRootFolders: vi.fn(),
  addSeries: vi.fn(),
};
vi.mock("@/lib/clients/radarr", () => ({ radarr: mockRadarr }));
vi.mock("@/lib/clients/sonarr", () => ({ sonarr: mockSonarr }));
const mockInvalidateLibrary = vi.fn();
vi.mock("@/lib/server-cache", () => ({ invalidateLibrary: () => mockInvalidateLibrary() }));

function fakeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const profiles = [{ id: 1, name: "HD-1080p" }, { id: 2, name: "VF-1080p" }];
const folders = [{ path: "/movies" }];

beforeEach(() => {
  vi.clearAllMocks();
  mockRadarr.getQualityProfiles.mockResolvedValue(profiles);
  mockRadarr.getRootFolders.mockResolvedValue(folders);
  mockSonarr.getQualityProfiles.mockResolvedValue(profiles);
  mockSonarr.getRootFolders.mockResolvedValue(folders);
});

describe("POST /api/discover/add", () => {
  it("returns 400 when type or tmdbId is missing", async () => {
    const { POST } = await import("@/app/api/discover/add/route");
    const res = await POST(fakeReq({ type: "movie" }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when the movie is not found on TMDB via Radarr's lookup", async () => {
    mockRadarr.lookupMovie.mockResolvedValue([]);
    const { POST } = await import("@/app/api/discover/add/route");
    const res = await POST(fakeReq({ type: "movie", tmdbId: 42 }));
    expect(res.status).toBe(404);
  });

  it("returns the existing radarrId without re-adding if the movie is already in Radarr", async () => {
    mockRadarr.lookupMovie.mockResolvedValue([{ id: 7, tmdbId: 42 }]);
    const { POST } = await import("@/app/api/discover/add/route");
    const res = await POST(fakeReq({ type: "movie", tmdbId: 42 }));
    const body = await res.json();
    expect(body).toEqual({ radarrId: 7 });
    expect(mockRadarr.addMovie).not.toHaveBeenCalled();
  });

  it("adds a new movie preferring the VF quality profile and the first root folder", async () => {
    mockRadarr.lookupMovie.mockResolvedValue([{ tmdbId: 42, title: "Dune" }]);
    mockRadarr.addMovie.mockResolvedValue({ id: 99 });
    const { POST } = await import("@/app/api/discover/add/route");
    const res = await POST(fakeReq({ type: "movie", tmdbId: 42 }));
    const body = await res.json();

    expect(body).toEqual({ radarrId: 99 });
    expect(mockRadarr.addMovie).toHaveBeenCalledWith(
      expect.objectContaining({ qualityProfileId: 2, rootFolderPath: "/movies", monitored: true })
    );
    expect(mockInvalidateLibrary).toHaveBeenCalled();
  });

  it("falls back to the first quality profile when none matches 'vf'", async () => {
    mockRadarr.getQualityProfiles.mockResolvedValue([{ id: 5, name: "HD-1080p" }]);
    mockRadarr.lookupMovie.mockResolvedValue([{ tmdbId: 42, title: "Dune" }]);
    mockRadarr.addMovie.mockResolvedValue({ id: 99 });
    const { POST } = await import("@/app/api/discover/add/route");
    await POST(fakeReq({ type: "movie", tmdbId: 42 }));
    expect(mockRadarr.addMovie).toHaveBeenCalledWith(expect.objectContaining({ qualityProfileId: 5 }));
  });

  it("returns 502 with the underlying error message when Radarr's add call fails", async () => {
    mockRadarr.lookupMovie.mockResolvedValue([{ tmdbId: 42, title: "Dune" }]);
    mockRadarr.addMovie.mockRejectedValue(new Error("Radarr unreachable"));
    const { POST } = await import("@/app/api/discover/add/route");
    const res = await POST(fakeReq({ type: "movie", tmdbId: 42 }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("Radarr unreachable");
  });

  it("adds a new series the same way through Sonarr", async () => {
    mockSonarr.lookupSeries.mockResolvedValue([{ tmdbId: 7, title: "Severance" }]);
    mockSonarr.addSeries.mockResolvedValue({ id: 55 });
    const { POST } = await import("@/app/api/discover/add/route");
    const res = await POST(fakeReq({ type: "series", tmdbId: 7 }));
    const body = await res.json();
    expect(body).toEqual({ sonarrId: 55 });
    expect(mockSonarr.addSeries).toHaveBeenCalledWith(
      expect.objectContaining({ qualityProfileId: 2, rootFolderPath: "/movies", monitored: true })
    );
  });

  it("returns 404 when the series is not found on TMDB via Sonarr's lookup", async () => {
    mockSonarr.lookupSeries.mockResolvedValue([]);
    const { POST } = await import("@/app/api/discover/add/route");
    const res = await POST(fakeReq({ type: "series", tmdbId: 7 }));
    expect(res.status).toBe(404);
  });
});
