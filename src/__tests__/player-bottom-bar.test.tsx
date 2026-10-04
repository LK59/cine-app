// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

let route = {
  tab: "movies" as const, film: null as number | null, serie: null as number | null,
  episodes: false, search: false, list: false, account: false,
  discover: null as number | null, discoverType: "movie" as const, person: null as number | null, browse: null as string | null,
};
let leaving = false;
let sheetBehind = false;
vi.mock("@/lib/cinemaRoute", () => ({
  useCinemaRoute: () => route,
  useSheetLeaving: () => leaving,
  useSheetBehind: () => sheetBehind,
}));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key }));
vi.mock("@/lib/useIsMobile", () => ({ useIsShortViewport: () => false }));
let scrolledAway = false;
vi.mock("@/lib/useHideOnScroll", () => ({ useHideOnScroll: () => scrolledAway }));
const mockOpenPanel = vi.fn();
vi.mock("@/components/player/playerNav", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/player/playerNav")>();
  return { ...actual, openPanel: (...a: unknown[]) => mockOpenPanel(...a) };
});

const mockSearchFocus = vi.fn();
vi.mock("@/lib/searchFocus", () => ({ requestSearchFocus: () => mockSearchFocus() }));

import { PlayerBottomBar } from "@/components/player/PlayerBottomBar";

beforeEach(() => {
  vi.clearAllMocks();
  scrolledAway = false;
  leaving = false;
  sheetBehind = false;
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

  // L'adresse garde le titre pendant toute l'animation de sortie de la fiche : attendre qu'elle
  // change mettait le retour de la barre *après* la sortie, deux mouvements bout à bout.
  it("comes back while the sheet is leaving, not after it", () => {
    route = { ...route, film: 42 };
    leaving = true;
    render(<PlayerBottomBar />);
    const bar = screen.getByLabelText("player.nav.label");
    expect(bar.style.visibility).toBe("visible");
    expect(bar.style.transform).toBe("none");
  });

  // Visible, mais pas encore touchable : l'adresse porte toujours le titre, et un onglet choisi à
  // ce moment s'empilait au-dessus de la fiche — le retour suivant la rouvrait.
  it("does not take a tap until the leaving sheet has left the address", () => {
    route = { ...route, film: 42 };
    leaving = true;
    const { rerender } = render(<PlayerBottomBar />);
    const bar = () => screen.getByLabelText("player.nav.label").firstElementChild as HTMLElement;
    expect(bar().className).toContain("pointer-events-none");
    route = { ...route, film: null };
    leaving = false;
    rerender(<PlayerBottomBar />);
    expect(bar().className).toContain("pointer-events-auto");
  });

  // Sous la fiche qui sort, une autre fiche : c'est elle qu'on découvre, et elle couvre l'écran.
  it("stays away when the leaving sheet uncovers another one", () => {
    route = { ...route, film: 42 };
    leaving = true;
    sheetBehind = true;
    render(<PlayerBottomBar />);
    expect(screen.getByLabelText("player.nav.label").style.visibility).toBe("hidden");
  });

  it("stays put the rest of the time", () => {
    render(<PlayerBottomBar />);
    expect(screen.getByLabelText("player.nav.label").style.visibility).toBe("visible");
  });

  // `visibility` ne s'interpole pas : appliquée en même temps que la translation, elle escamotait
  // la barre à l'instant zéro et l'animation ne se voyait jamais. Elle attend donc la fin du
  // mouvement pour sortir — et n'attend rien pour revenir.
  it("waits for the slide to finish before going invisible, and not the other way round", () => {
    scrolledAway = true;
    const { rerender } = render(<PlayerBottomBar />);
    const bar = screen.getByLabelText("player.nav.label");
    expect(bar.style.transform).toContain("translateY");
    expect(bar.style.transition).toMatch(/visibility 0s linear [1-9]\d*ms/);

    scrolledAway = false;
    rerender(<PlayerBottomBar />);
    expect(screen.getByLabelText("player.nav.label").style.transition).toContain("visibility 0s linear 0ms");
  });
});

// 04/10/2026 : partir de Recherche en faisant glisser la lentille ouvrait le clavier dès le contact,
// et le clavier cassait le geste. Il ne monte plus qu'à un appui relâché sur Recherche.
describe("le second appui sur Recherche", () => {
  const onSearch = () => {
    route = { ...route, search: true, ...({ activity: null, report: null } as object) };
  };
  const searchButton = () => screen.getByText("player.nav.search").closest("button")!;

  it("ne lève pas le clavier au contact, mais au relâchement sur Recherche", () => {
    onSearch();
    render(<PlayerBottomBar />);
    fireEvent.pointerDown(searchButton(), { button: 0, pointerType: "touch", pointerId: 7 });
    expect(mockSearchFocus).not.toHaveBeenCalled();
    expect(mockOpenPanel).not.toHaveBeenCalled();
    fireEvent.pointerUp(searchButton(), { pointerId: 7 });
    expect(mockSearchFocus).toHaveBeenCalledTimes(1);
  });

  it("ne le lève pas si le geste a été repris (défilement, système)", () => {
    onSearch();
    render(<PlayerBottomBar />);
    fireEvent.pointerDown(searchButton(), { button: 0, pointerType: "touch", pointerId: 8 });
    fireEvent.pointerCancel(searchButton(), { pointerId: 8 });
    fireEvent.pointerUp(searchButton(), { pointerId: 8 });
    expect(mockSearchFocus).not.toHaveBeenCalled();
  });

  it("ouvre toujours Recherche au contact depuis un autre onglet, sans clavier", () => {
    render(<PlayerBottomBar />);
    fireEvent.pointerDown(searchButton(), { button: 0, pointerType: "touch", pointerId: 9 });
    expect(mockOpenPanel).toHaveBeenCalledWith("search", route);
    fireEvent.pointerUp(searchButton(), { pointerId: 9 });
    expect(mockSearchFocus).not.toHaveBeenCalled();
  });
});
