// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, back: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));
const mockUseRole = vi.fn();
vi.mock("@/lib/useRole", () => ({ useRole: () => mockUseRole() }));

import { GlobalSearch } from "@/components/GlobalSearch";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockClear();
});

const movie = {
  id: 1,
  title: "Inception",
  year: 2010,
  monitored: true,
  hasFile: true,
  status: "released",
  images: [],
  qualityProfileId: 1,
  sizeOnDisk: 0,
  tmdbId: 100,
};

const series = {
  id: 2,
  title: "Breaking Bad",
  year: 2008,
  monitored: true,
  status: "ended",
  images: [],
  qualityProfileId: 1,
  seasonCount: 5,
  tvdbId: 1,
  tmdbId: 200,
};

function stubFetch(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      if (url === "/api/radarr/movies") return Promise.resolve({ ok: true, json: async () => [movie] });
      if (url === "/api/sonarr/series") return Promise.resolve({ ok: true, json: async () => [series] });
      if (url.startsWith("/api/watchlist/bulk-status")) return Promise.resolve({ ok: true, json: async () => ({}) });
      if (url.startsWith("/api/search")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ tmdb: [], persons: [], library: [], ...overrides }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    })
  );
}

function renderSearch() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <GlobalSearch />
    </SWRConfig>
  );
}

describe("GlobalSearch", () => {
  it("renders nothing until opened", async () => {
    mockUseRole.mockReturnValue({ role: "admin" });
    stubFetch();
    renderSearch();
    expect(screen.queryByPlaceholderText("search.placeholder")).not.toBeInTheDocument();
    // The component's own preload SWR fetches (movies/series) run regardless of `open` — let
    // them settle before the test ends so their state updates land inside act().
    await act(async () => {});
  });

  it("opens on the 'open-search' custom event (mobile trigger)", async () => {
    mockUseRole.mockReturnValue({ role: "admin" });
    stubFetch();
    renderSearch();

    fireEvent(window, new CustomEvent("open-search"));
    expect(await screen.findByPlaceholderText("search.placeholder")).toBeInTheDocument();
  });

  it("opens on Ctrl+K and closes on Escape", async () => {
    mockUseRole.mockReturnValue({ role: "admin" });
    stubFetch();
    renderSearch();

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(await screen.findByPlaceholderText("search.placeholder")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByPlaceholderText("search.placeholder")).not.toBeInTheDocument());
  });

  it("shows a locally-matched library title and navigates to it on click", async () => {
    mockUseRole.mockReturnValue({ role: "admin" });
    stubFetch();
    const user = userEvent.setup();
    renderSearch();
    fireEvent(window, new CustomEvent("open-search"));
    const input = await screen.findByPlaceholderText("search.placeholder");

    await user.type(input, "Inception");
    await waitFor(() => expect(screen.getByText("Inception")).toBeInTheDocument());

    await user.click(screen.getByText("Inception"));
    expect(push).toHaveBeenCalledWith("/radarr/1");
  });

  it("does not match a series when the query explicitly asks for a movie", async () => {
    mockUseRole.mockReturnValue({ role: "admin" });
    stubFetch();
    const user = userEvent.setup();
    renderSearch();
    fireEvent(window, new CustomEvent("open-search"));
    const input = await screen.findByPlaceholderText("search.placeholder");

    await user.type(input, "Breaking film");
    await waitFor(() => expect(input).toHaveValue("Breaking film"));

    expect(screen.queryByText("Breaking Bad")).not.toBeInTheDocument();
  });

  it("ArrowDown/ArrowUp move the cursor and Enter navigates to the highlighted result", async () => {
    mockUseRole.mockReturnValue({ role: "admin" });
    stubFetch();
    const user = userEvent.setup();
    renderSearch();
    fireEvent(window, new CustomEvent("open-search"));
    const input = await screen.findByPlaceholderText("search.placeholder");

    await user.type(input, "Inception");
    await waitFor(() => expect(screen.getByText("Inception")).toBeInTheDocument());

    await user.keyboard("{Enter}");
    expect(push).toHaveBeenCalledWith("/radarr/1");
  });

  it("debounces the remote search — no /api/search call before 300ms, one call after", async () => {
    mockUseRole.mockReturnValue({ role: "admin" });
    stubFetch();
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/radarr/movies") return Promise.resolve({ ok: true, json: async () => [movie] });
      if (url === "/api/sonarr/series") return Promise.resolve({ ok: true, json: async () => [series] });
      if (url.startsWith("/api/watchlist/bulk-status")) return Promise.resolve({ ok: true, json: async () => ({}) });
      return Promise.resolve({ ok: true, json: async () => ({ tmdb: [], persons: [], library: [] }) });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const user = userEvent.setup();
    renderSearch();
    fireEvent(window, new CustomEvent("open-search"));
    const input = await screen.findByPlaceholderText("search.placeholder");

    await user.type(input, "xy");
    expect(fetchSpy.mock.calls.some(([u]) => typeof u === "string" && u.startsWith("/api/search"))).toBe(false);

    await waitFor(
      () => expect(fetchSpy.mock.calls.some(([u]) => typeof u === "string" && u.startsWith("/api/search?q=xy"))).toBe(true),
      { timeout: 1000 }
    );
  });

  it("shows a TMDb result not already in the library and requests it via Jellyseerr on click", async () => {
    mockUseRole.mockReturnValue({ role: "admin" });
    stubFetch({
      tmdb: [{ tmdbId: 999, title: "New Movie", type: "movie", year: 2024, rating: 7.5, posterPath: null }],
    });
    const requestFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url === "/api/jellyseerr/requests") return requestFetch(url, init);
        if (url === "/api/radarr/movies") return Promise.resolve({ ok: true, json: async () => [movie] });
        if (url === "/api/sonarr/series") return Promise.resolve({ ok: true, json: async () => [series] });
        if (url.startsWith("/api/watchlist/bulk-status")) return Promise.resolve({ ok: true, json: async () => ({}) });
        if (url.startsWith("/api/search")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ tmdb: [{ tmdbId: 999, title: "New Movie", type: "movie", year: 2024, rating: 7.5, posterPath: null }], persons: [], library: [] }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      })
    );
    const user = userEvent.setup();
    renderSearch();
    fireEvent(window, new CustomEvent("open-search"));
    const input = await screen.findByPlaceholderText("search.placeholder");

    await user.type(input, "New Movie");
    await waitFor(() => expect(screen.getByText("New Movie")).toBeInTheDocument(), { timeout: 1000 });

    await user.click(screen.getByTitle("search.requestViaJellyseerr"));
    await waitFor(() => expect(requestFetch).toHaveBeenCalled());
  });
});
