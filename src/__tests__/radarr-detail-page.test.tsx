// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "123" }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string) => key,
}));
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

const mockUseRole = vi.fn();
vi.mock("@/lib/useRole", () => ({
  useRole: () => mockUseRole(),
}));

import RadarrMovieDetailPage from "@/app/(dashboard)/radarr/[id]/page";

// A fresh Map-backed SWR cache per render — otherwise every test in this file shares SWR's
// default global cache keyed on the same fixed URLs ("/api/radarr/movies/123", etc.), so a later
// test's fetch mock (e.g. a different hasFile) can be starved by an earlier test's still-cached,
// still-within-dedupingInterval response.
function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <RadarrMovieDetailPage />
    </SWRConfig>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const baseMovie = {
  id: 123,
  title: "Test Movie",
  year: 2024,
  tmdbId: 999,
  imdbId: "tt123",
  monitored: true,
  qualityProfileId: 1,
  status: "released",
  images: [],
  movieFile: null,
};

// Routes only this page's fetch calls directly (movie/info/meta/jellyfin-item/jellyseerr-media);
// anything else (MediaRatings, SimilarMedia, WatchlistButton's own item lookup — each does its
// own internal useSWR fetch) gets a harmless empty-object fallback, since none of that data
// drives the guest-vs-admin button visibility this test actually cares about.
function mockMovieFetches(hasFile: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url === "/api/radarr/movies/123") {
        return Promise.resolve({ ok: true, json: async () => ({ ...baseMovie, hasFile } as unknown) });
      }
      if (url.startsWith("/api/radarr/movies/123/info")) {
        return Promise.resolve({ ok: true, json: async () => ({ subtitles: [], audioLanguages: [] }) });
      }
      if (url.startsWith("/api/radarr/meta")) {
        return Promise.resolve({ ok: true, json: async () => ({ qualityProfiles: [], rootFolders: [] }) });
      }
      if (url.startsWith("/api/jellyfin/items")) {
        // No Jellyfin match → PlayButton/watched-toggle never render, out of scope here.
        return Promise.resolve({ ok: true, json: async () => ({ item: null }) });
      }
      if (url.startsWith("/api/jellyseerr/media")) {
        return Promise.resolve({ ok: true, json: async () => ({ status: 0 }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    })
  );
}

describe("Radarr movie detail page — guest button visibility", () => {
  it("admin always sees auto-search, NFO, and interactive search, file or not", async () => {
    mockUseRole.mockReturnValue({ isGuest: false, role: "admin", jfId: null, jfUser: null });
    mockMovieFetches(true);
    renderPage();

    expect(await screen.findByText("common.autoSearch")).toBeInTheDocument();
    expect(screen.getByText("NFO")).toBeInTheDocument();
    expect(screen.getByText("common.interactiveSearch")).toBeInTheDocument();
    expect(screen.getByText("radarr.deleteFromRadarr")).toBeInTheDocument();
  });

  it("guest with a downloaded file sees no search action at all — a file is a fact — but still sees NFO", async () => {
    mockUseRole.mockReturnValue({ isGuest: true, role: "guest", jfId: "x", jfUser: "invite" });
    mockMovieFetches(true);
    renderPage();

    await screen.findByText("Test Movie");
    expect(screen.queryByText("common.autoSearch")).not.toBeInTheDocument();
    expect(screen.queryByText("common.interactiveSearch")).not.toBeInTheDocument();
    expect(screen.queryByText("radarr.deleteFromRadarr")).not.toBeInTheDocument();
    // NFO is read-only (file path/codec/bitrate) — no reason to hide it from guests.
    expect(screen.getByText("NFO")).toBeInTheDocument();
  });

  it("guest with no file yet sees exactly auto-search, never interactive search, but still sees NFO", async () => {
    mockUseRole.mockReturnValue({ isGuest: true, role: "guest", jfId: "x", jfUser: "invite" });
    mockMovieFetches(false);
    renderPage();

    expect(await screen.findByText("common.autoSearch")).toBeInTheDocument();
    expect(screen.queryByText("common.interactiveSearch")).not.toBeInTheDocument();
    expect(screen.getByText("NFO")).toBeInTheDocument();
  });
});
