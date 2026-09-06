// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

let route = {
  tab: "movies" as const, film: null as number | null, serie: null as number | null,
  episodes: false, search: false, list: false, account: false,
  discover: null as number | null, discoverType: "movie" as const, person: null as number | null, browse: null as string | null,
};
vi.mock("@/lib/cinemaRoute", () => ({ useCinemaRoute: () => route }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key }));
vi.mock("@/lib/useIsMobile", () => ({ useIsShortViewport: () => false }));
vi.mock("@/lib/useHideOnScroll", () => ({ useHideOnScroll: () => false }));
const mockOpenPanel = vi.fn();
vi.mock("@/components/player/playerNav", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/player/playerNav")>();
  return { ...actual, openPanel: (...a: unknown[]) => mockOpenPanel(...a) };
});

import { PlayerBottomBar } from "@/components/player/PlayerBottomBar";

beforeEach(() => {
  vi.clearAllMocks();
  route = { ...route, search: false, list: false, account: false, film: null, discover: null, person: null };
});
afterEach(cleanup);

describe("PlayerBottomBar", () => {
  it("offers the four destinations", () => {
    render(<PlayerBottomBar />);
    for (const key of ["player.nav.home", "player.nav.search", "player.nav.myList", "player.nav.account"]) {
      expect(screen.getByText(key)).toBeTruthy();
    }
  });

  it("marks where you are", () => {
    route = { ...route, list: true };
    render(<PlayerBottomBar />);
    const current = screen.getByText("player.nav.myList").closest("button");
    expect(current?.getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("player.nav.home").closest("button")?.getAttribute("aria-current")).toBeNull();
  });

  // Le geste part au contact et non au clic : sur téléphone, `click` arrive trois cents
  // millisecondes après le doigt, et une navigation qui ne coûte rien doit être instantanée.
  it("navigates on the touch rather than on the click", () => {
    render(<PlayerBottomBar />);
    fireEvent.pointerDown(screen.getByText("player.nav.myList").closest("button")!, { button: 0, pointerType: "touch" });
    expect(mockOpenPanel).toHaveBeenCalledWith("list", route);
  });

  // Une fiche recouvre l'écran entier : la barre y flotterait au-dessus d'un contenu qu'elle ne
  // commande pas.
  it("gets out of the way while a sheet is open", () => {
    route = { ...route, film: 42 };
    render(<PlayerBottomBar />);
    expect(screen.getByLabelText("player.nav.label").style.visibility).toBe("hidden");
  });

  it("stays put the rest of the time", () => {
    render(<PlayerBottomBar />);
    expect(screen.getByLabelText("player.nav.label").style.visibility).toBe("visible");
  });
});
