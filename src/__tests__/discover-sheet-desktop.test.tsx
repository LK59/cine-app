// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * La fiche découverte (titre absent de la bibliothèque) sur ordinateur, mise en page comme celle
 * d'un film possédé (14/10/2026, DECISIONS.md §61).
 *
 * Capture de Louis, « Matchbox – Le film » ouvert pour « Demander » : le titre se dessinait sous le
 * bouton Retour, et la distribution était sur le premier écran. La rangée de visages vivait dans la
 * colonne d'un premier écran qui tient dans la fenêtre et se cale en bas (`SECTION_CLASS`) : elle la
 * faisait déborder par le haut. Les deux pages et leurs pièces viennent désormais de
 * `CinemaDetailPages`, comme pour le film et la série.
 */
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string) => k,
  useLocale: () => ({ locale: "fr" }),
}));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => false, useIsShortViewport: () => false, useIsTouch: () => false }));
vi.mock("@/lib/usePlayerTitleActions", () => ({
  usePlayerTitleActions: () => ({ busy: false, setStatus: vi.fn(), request: vi.fn(), cancelRequest: vi.fn() }),
}));
vi.mock("@/lib/useTitleWatched", () => ({ useTitleWatched: () => ({ watched: false, busy: false, toggle: vi.fn() }) }));
vi.mock("@/lib/cinemaRoute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cinemaRoute")>()),
  arrivedByBack: () => false,
}));

let payload: Record<string, unknown>;
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: async (key: string) => (key.startsWith("/api/player/title/") ? payload : {}),
}));

import { PlayerDiscoverSheet } from "@/components/player/PlayerDiscoverSheet";

const MATCHBOX = {
  tmdbId: 2,
  type: "movie",
  title: "Matchbox – Le film",
  year: 2026,
  releaseDate: "2026-10-10",
  overview: "Des petites voitures.",
  tagline: null,
  poster: null,
  backdrop: null,
  genres: ["Animation"],
  runtime: 100,
  rating: 7,
  cast: [
    { id: 11, name: "Acteur Un", character: "A", profilePath: null },
    { id: 12, name: "Actrice Deux", character: "B", profilePath: null },
  ],
  libraryId: null,
  requestState: null,
  watchlistStatus: null,
  downloading: null,
  watched: false,
  posterPath: null,
  logo: null,
};

function mount(over: Record<string, unknown> = {}) {
  payload = { ...MATCHBOX, ...over };
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PlayerDiscoverSheet tmdbId={2} mediaType="movie" />
    </SWRConfig>
  );
}
const pages = () => document.body.querySelector<HTMLElement>("[data-detail-pages]")!;
const sections = () => Array.from(pages().querySelectorAll<HTMLElement>(":scope > [data-snap-section]"));

afterEach(cleanup);

describe("fiche découverte, ordinateur — la mise en page d'une fiche film", () => {
  it("deux pages : l'en-tête et les actions, puis la distribution", async () => {
    mount();
    await screen.findByRole("heading", { level: 1, name: "Matchbox – Le film" });
    const [first, second] = sections();
    expect(sections()).toHaveLength(2);
    expect(first.querySelector("h1")?.textContent).toBe("Matchbox – Le film");
    expect(first.querySelector("[data-detail-actions]")).not.toBeNull();
    // Le premier écran se cale en bas et tient dans la fenêtre — le même que la fiche film.
    expect(first.className).toContain("justify-end");
    expect(first.className).toContain("h-full");
    // Les visages sur la seconde page, plus sur la première.
    expect(first.textContent).not.toContain("cinema.castTitle");
    expect(second.textContent).toContain("cinema.castTitle");
    expect(second.textContent).toContain("Acteur Un");
    // La ligne « Avec » reste en tête, comme sur la fiche film.
    expect(first.textContent).toContain("cinema.cast");
  });

  it("le bouton Retour est hors du défilement, au-dessus de lui ; le titre est dans la colonne", async () => {
    mount();
    const title = await screen.findByRole("heading", { level: 1, name: "Matchbox – Le film" });
    const back = screen.getByText("cinema.back").closest("button")!;
    expect(pages().contains(back)).toBe(false);
    expect(back.className).toContain("z-10");
    expect(title.closest("[data-sheet-content]")?.parentElement).toBe(sections()[0]);
    // Dans le document : Retour avant les pages, le titre en tête de colonne, puis les actions.
    expect(back.compareDocumentPosition(pages()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const column = title.closest("[data-sheet-content]")!;
    expect(column.firstElementChild).toBe(title);
  });

  it("le logo du titre quand il en a un, comme la fiche film", async () => {
    mount({ logo: "https://image.tmdb.org/t/p/w500/logo.png" });
    const logo = await screen.findByAltText("Matchbox – Le film");
    expect(logo.closest("[data-sheet-content]")?.parentElement).toBe(sections()[0]);
  });

  // 15/10/2026 (passe de nuit, BUREAU-8) : « Demander » recevait le focus à l'ouverture — Entrée pour
  // ouvrir l'affiche, Entrée encore (télécommande qui répète) et une vraie demande partait.
  it("ne pose pas le focus d'arrivée sur « Demander », mais sur la ligne suivante", async () => {
    mount();
    await screen.findByRole("heading", { level: 1, name: "Matchbox – Le film" });
    await vi.waitFor(() => expect(document.activeElement?.textContent).toContain("player.discover.addToList"));
    expect(document.activeElement?.textContent).not.toContain("player.discover.request");
  });

  it("garde le focus d'arrivée sur « Ouvrir » quand le titre est là", async () => {
    mount({ libraryId: 42 });
    await screen.findByRole("heading", { level: 1, name: "Matchbox – Le film" });
    await vi.waitFor(() => expect(document.activeElement?.textContent).toContain("player.discover.open"));
  });

  it("sans distribution, une seule page", async () => {
    mount({ cast: [] });
    await screen.findByRole("heading", { level: 1, name: "Matchbox – Le film" });
    expect(sections()).toHaveLength(1);
  });
});
