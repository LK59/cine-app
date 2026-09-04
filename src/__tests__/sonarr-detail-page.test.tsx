// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "123" }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}));
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

const mockUseRole = vi.fn();
vi.mock("@/lib/useRole", () => ({
  useRole: () => mockUseRole(),
}));

import SonarrSeriesDetailPage from "@/app/(dashboard)/sonarr/[id]/page";

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SonarrSeriesDetailPage />
    </SWRConfig>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const baseSeries = {
  id: 123,
  title: "Test Show",
  year: 2024,
  monitored: true,
  status: "continuing",
  images: [],
  qualityProfileId: 1,
  seasonCount: 1,
  seasons: [],
  tvdbId: 555,
  tmdbId: 999,
};

// One season, one fully-downloaded episode (hasFile) and one still-missing episode — lets a
// single render exercise both the "complete season" and "incomplete season" auto-search rule at
// once (season-level: fileCount < total; episode-level search icon is admin-only regardless).
function episodesFor(complete: boolean) {
  return [
    { id: 1, seriesId: 123, seasonNumber: 1, episodeNumber: 1, title: "Ep 1", monitored: true, hasFile: true },
    { id: 2, seriesId: 123, seasonNumber: 1, episodeNumber: 2, title: "Ep 2", monitored: true, hasFile: complete },
  ];
}

function mockSeriesFetches(seasonComplete: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url === "/api/sonarr/series/123") {
        return Promise.resolve({ ok: true, json: async () => baseSeries });
      }
      if (url === "/api/sonarr/series/123/episodes") {
        return Promise.resolve({ ok: true, json: async () => episodesFor(seasonComplete) });
      }
      if (url.startsWith("/api/sonarr/series/123/info")) {
        return Promise.resolve({ ok: true, json: async () => ({ episodeSubtitles: [], activeDownloads: [] }) });
      }
      if (url.startsWith("/api/sonarr/meta")) {
        return Promise.resolve({ ok: true, json: async () => ({ qualityProfiles: [] }) });
      }
      if (url.startsWith("/api/jellyfin/items")) {
        return Promise.resolve({ ok: true, json: async () => ({ item: null }) });
      }
      if (url.startsWith("/api/jellyseerr/media")) {
        return Promise.resolve({ ok: true, json: async () => ({ status: 0 }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    })
  );
}

describe("Sonarr series detail page — guest button visibility", () => {
  it("admin always sees the season auto-search button, complete or not, plus per-episode search", async () => {
    mockUseRole.mockReturnValue({ isGuest: false, role: "admin", jfId: null, jfUser: null });
    mockSeriesFetches(true);
    renderPage();

    expect(await screen.findAllByLabelText("common.autoSearch")).toHaveLength(1);

    // Seasons start collapsed — expand it to reach the per-episode search icon buttons
    // (admin-only, title includes the episode name).
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    await user.click(screen.getByText('sonarr.seasonLabel:{"n":"1"}'));

    expect(await screen.findByTitle('sonarr.episodeSearch:{"title":"Ep 1"}')).toBeInTheDocument();
    expect(screen.getByTitle('sonarr.episodeSearch:{"title":"Ep 2"}')).toBeInTheDocument();
  });

  it("guest sees the season auto-search button while the season is incomplete", async () => {
    mockUseRole.mockReturnValue({ isGuest: true, role: "guest", jfId: "x", jfUser: "invite" });
    mockSeriesFetches(false);
    renderPage();

    expect(await screen.findByLabelText("common.autoSearch")).toBeInTheDocument();
    expect(screen.queryByTitle('sonarr.episodeSearch:{"title":"Ep 1"}')).not.toBeInTheDocument();
  });

  it("guest never sees the season auto-search button once every episode has a file", async () => {
    mockUseRole.mockReturnValue({ isGuest: true, role: "guest", jfId: "x", jfUser: "invite" });
    mockSeriesFetches(true);
    renderPage();

    await screen.findByText("Test Show");
    expect(screen.queryByLabelText("common.autoSearch")).not.toBeInTheDocument();
  });
});
