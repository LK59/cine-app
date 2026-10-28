// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";

/**
 * La fiche d'un livre suit le cycle de vie des fiches de films (DECISIONS.md §127, CLAUDE.md « The
 * sheet lifecycle ») : nommée par l'adresse du cinéma (`#livre=<id>`), refermée par `cinemaClose` — un
 * seul `history.back()` en vol, quel que soit le nombre d'Échap —, montée tant que l'adresse la nomme
 * puis gardée le temps de sa sortie, et muette pendant cette sortie.
 */
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("swr", () => ({ default: () => ({ data: undefined, error: undefined }) }));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => false }));
// Le trajet de la couverture est éprouvé par ses propres tests ; ici, seul le cycle de vie compte.
vi.mock("@/lib/sheetMorph/desktopContinuity", () => ({ useSheetTransition: () => ({ handlesEntry: false, settled: true }) }));

import { BookSheetHost } from "@/components/books/BookSheet";
import { cinemaNavigate, readCinemaRoute } from "@/lib/cinemaRoute";

const ID = "ab".repeat(16);
const book = { id: ID, name: "Arizona Max", coverTag: null, fileTag: null, seriesName: null, index: null, year: 2009, authors: ["Robert Muchamore"], genres: [], addedAt: null, played: false, progress: null };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
beforeEach(() => {
  window.history.replaceState(null, "", "/#livres=1");
});

describe("l'adresse", () => {
  it("la fiche et son lecteur sont dans le fragment ; un identifiant mal formé ne nomme rien", () => {
    window.location.hash = `#livres=1&livre=${ID}&lire=1`;
    expect(readCinemaRoute()).toMatchObject({ books: true, book: ID, reading: true });
    window.location.hash = "#livre=../../x&lire=1";
    expect(readCinemaRoute().book).toBeUndefined();
    window.location.hash = "#tab=series";
    expect("book" in readCinemaRoute()).toBe(false);
  });
});

describe("la fiche", () => {
  it("ouverte par une entrée d'historique, refermée par un seul retour même sous trois Échap", async () => {
    act(() => cinemaNavigate({ book: ID, reading: false }));
    expect(window.location.hash).toContain(`livre=${ID}`);
    const back = vi.spyOn(window.history, "back");
    const { queryByRole } = render(<BookSheetHost books={[book]} onRead={() => {}} />);
    expect(queryByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(back).toHaveBeenCalledTimes(1);
    // Le vrai retour arrive : l'adresse ne nomme plus le livre, la fiche sort puis se démonte.
    await vi.waitFor(() => expect(readCinemaRoute().book).toBeUndefined());
    await vi.waitFor(() => expect(queryByRole("dialog", { hidden: true })).toBeNull(), { timeout: 2000 });
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("pendant sa sortie, elle n'écoute plus", async () => {
    act(() => cinemaNavigate({ book: ID, reading: false }));
    const { queryByRole } = render(<BookSheetHost books={[book]} onRead={() => {}} />);
    act(() => window.history.back());
    await vi.waitFor(() => expect(readCinemaRoute().book).toBeUndefined());
    const back = vi.spyOn(window.history, "back");
    // Encore montée le temps de sa sortie, mais sourde : un Échap ne recule pas d'un cran de plus.
    expect(queryByRole("dialog", { hidden: true })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(back).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(queryByRole("dialog", { hidden: true })).toBeNull(), { timeout: 2000 });
  });

  it("« Lire » passe la couverture au lecteur", () => {
    act(() => cinemaNavigate({ book: ID, reading: false }));
    const onRead = vi.fn();
    const { getByText } = render(<BookSheetHost books={[book]} onRead={onRead} />);
    fireEvent.click(getByText("books.read"));
    expect(onRead).toHaveBeenCalledWith(book, ID, expect.any(HTMLElement));
  });
});
