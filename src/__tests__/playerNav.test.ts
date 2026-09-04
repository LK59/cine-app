import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CinemaRoute } from "@/lib/cinemaRoute";

const mockNavigate = vi.fn();
vi.mock("@/lib/cinemaRoute", () => ({ cinemaNavigate: (...args: unknown[]) => mockNavigate(...args) }));

const EMPTY: CinemaRoute = {
  tab: "movies",
  film: null,
  serie: null,
  episodes: false,
  search: false,
  list: false,
  account: false,
  discover: null,
  discoverType: "movie",
  person: null,
  menu: false,
};

beforeEach(() => vi.clearAllMocks());

describe("activePanel", () => {
  it("names the open panel, and home when none is", async () => {
    const { activePanel } = await import("@/components/player/playerNav");
    expect(activePanel(EMPTY)).toBe("home");
    expect(activePanel({ ...EMPTY, search: true })).toBe("search");
    expect(activePanel({ ...EMPTY, list: true })).toBe("list");
    expect(activePanel({ ...EMPTY, account: true })).toBe("account");
  });
});

describe("openPanel", () => {
  it("replaces the open panel instead of stacking it", async () => {
    const { openPanel } = await import("@/components/player/playerNav");
    openPanel("list", { ...EMPTY, search: true });
    const [patch] = mockNavigate.mock.calls[0];
    expect(patch).toMatchObject({ search: false, list: true, account: false });
  });

  // Sans ça, revenir en arrière depuis « Ma liste » rouvrirait la fiche qu'on croyait fermée.
  it("closes any open sheet on the way", async () => {
    const { openPanel } = await import("@/components/player/playerNav");
    openPanel("search", { ...EMPTY, film: 12, episodes: true, person: 5 });
    const [patch] = mockNavigate.mock.calls[0];
    expect(patch).toMatchObject({ film: null, serie: null, episodes: false, person: null, discover: null });
  });

  it("does nothing when the panel asked for is already the open one", async () => {
    const { openPanel } = await import("@/components/player/playerNav");
    openPanel("account", { ...EMPTY, account: true });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("goes home by closing everything, and replaces the entry when already home", async () => {
    const { openPanel } = await import("@/components/player/playerNav");
    openPanel("home", { ...EMPTY, list: true });
    expect(mockNavigate.mock.calls[0][1]).toBe("push");

    mockNavigate.mockClear();
    openPanel("home", EMPTY);
    expect(mockNavigate.mock.calls[0][1]).toBe("replace");
  });
});
