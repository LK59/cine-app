import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { config } from "@/lib/config";
import { radarr } from "@/lib/clients/radarr";
import { sonarr } from "@/lib/clients/sonarr";
import { jellyfin } from "@/lib/clients/jellyfin";

const originalFetch = global.fetch;

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue(okJson({}));
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("radarr client", () => {
  it("getMovie fetches the correct URL with API key header", async () => {
    await radarr.getMovie(42);
    expect(global.fetch).toHaveBeenCalledWith(
      `${config.radarr.url}/api/v3/movie/42`,
      expect.objectContaining({ headers: expect.objectContaining({ "X-Api-Key": config.radarr.apiKey }) })
    );
  });

  it("addMovie POSTs a JSON body", async () => {
    await radarr.addMovie({ tmdbId: 42, title: "Dune" });
    expect(global.fetch).toHaveBeenCalledWith(
      `${config.radarr.url}/api/v3/movie`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ tmdbId: 42, title: "Dune" }) })
    );
  });

  it("deleteMovie issues a DELETE with deleteFiles=false", async () => {
    await radarr.deleteMovie(7);
    expect(global.fetch).toHaveBeenCalledWith(
      `${config.radarr.url}/api/v3/movie/7?deleteFiles=false`,
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("lookupMovie encodes the search term", async () => {
    await radarr.lookupMovie("dune part two");
    expect(global.fetch).toHaveBeenCalledWith(
      `${config.radarr.url}/api/v3/movie/lookup?term=dune%20part%20two`,
      expect.anything()
    );
  });

  it("grabRelease POSTs guid and indexerId", async () => {
    await radarr.grabRelease("abc-guid", 3);
    expect(global.fetch).toHaveBeenCalledWith(
      `${config.radarr.url}/api/v3/release`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ guid: "abc-guid", indexerId: 3 }) })
    );
  });
});

describe("sonarr client", () => {
  it("getSeriesById fetches the correct URL", async () => {
    await sonarr.getSeriesById(10);
    expect(global.fetch).toHaveBeenCalledWith(
      `${config.sonarr.url}/api/v3/series/10`,
      expect.objectContaining({ headers: expect.objectContaining({ "X-Api-Key": config.sonarr.apiKey }) })
    );
  });
});

describe("jellyfin client", () => {
  it("getSystemInfo uses the Emby token header", async () => {
    await jellyfin.getSystemInfo();
    expect(global.fetch).toHaveBeenCalledWith(
      `${config.jellyfin.url}/System/Info`,
      expect.objectContaining({ headers: expect.objectContaining({ "X-Emby-Token": config.jellyfin.apiKey }) })
    );
  });

  it("getAllMovies scopes the request to the given userId", async () => {
    await jellyfin.getAllMovies("user-abc");
    const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain("/Users/user-abc/Items");
    expect(calledUrl).toContain("IncludeItemTypes=Movie");
  });

  it("refreshLibrary POSTs to the Library/Refresh endpoint", async () => {
    await jellyfin.refreshLibrary();
    expect(global.fetch).toHaveBeenCalledWith(
      `${config.jellyfin.url}/Library/Refresh`,
      expect.objectContaining({ method: "POST" })
    );
  });
});
