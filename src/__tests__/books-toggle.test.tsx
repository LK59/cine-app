// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, renderHook } from "@testing-library/react";

/**
 * Les livres, troisième catégorie de la bascule du cinéma (option, DECISIONS.md §127) : option
 * coupée, la bascule rend ses deux boutons d'avant et rien d'autre ; allumée, un troisième, qui pose
 * un mode (`#livres=1`) sans toucher à `tab`.
 */
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
const config = vi.hoisted(() => ({ data: undefined as { booksEnabled?: boolean } | undefined, keys: [] as unknown[] }));
vi.mock("swr", () => ({
  default: (key: unknown) => {
    config.keys.push(key);
    return { data: config.data };
  },
}));
// Le module de la section « Livres » de la recherche : s'il était chargé, ce serait par là.
const searchLoaded = vi.hoisted(() => vi.fn());
vi.mock("@/components/books/BooksSearch", () => {
  searchLoaded();
  return { BooksSearch: () => <div data-books-search /> };
});
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cinemaRoute", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/cinemaRoute")>();
  return { ...real, cinemaNavigate: (...a: unknown[]) => navigate(...a) };
});

import { CinemaModeToggle } from "@/components/cinema/CinemaModeToggle";
import { BooksSearchEntry, useBooksMode } from "@/components/books/BooksMode";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  config.data = undefined;
  config.keys = [];
});

describe("la bascule", () => {
  it("sans livres : exactement les deux boutons d'avant, qui appellent `onChange`", () => {
    const onChange = vi.fn();
    render(<CinemaModeToggle placement="inline" mode="movies" onChange={onChange} />);
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("data-lens"))).toEqual(["movies", "series"]);
    fireEvent.click(screen.getByText("cinema.seriesTab"));
    expect(onChange).toHaveBeenCalledWith("series");
    // Les flèches passent d'un onglet à l'autre, comme avant.
    fireEvent.keyDown(screen.getByText("cinema.moviesTab"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("series");
  });

  it("avec les livres : un troisième bouton ; en sortir passe par `onLeave`, jamais par `onChange`", () => {
    const onChange = vi.fn();
    const books = { active: true, onSelect: vi.fn(), onLeave: vi.fn() };
    render(<CinemaModeToggle mode="series" onChange={onChange} books={books} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("data-lens"))).toEqual(["movies", "series", "books"]);
    expect(screen.getByText("books.nav").closest("button")!.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("cinema.seriesTab").closest("button")!.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByText("cinema.moviesTab"));
    expect(books.onLeave).toHaveBeenCalledWith("movies");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByText("books.nav"), { key: "ArrowRight" });
    expect(books.onLeave).toHaveBeenLastCalledWith("movies");
  });

  it("depuis un onglet, le bouton Livres appelle `onSelect`", () => {
    const books = { active: false, onSelect: vi.fn(), onLeave: vi.fn() };
    render(<CinemaModeToggle mode="movies" onChange={vi.fn()} books={books} />);
    fireEvent.click(screen.getByText("books.nav"));
    expect(books.onSelect).toHaveBeenCalled();
  });
});

describe("useBooksMode", () => {
  it("option coupée (ou pas encore lue) : aucun troisième bouton, aucun mode", () => {
    const { result, rerender } = renderHook(({ inAddress }) => useBooksMode(inAddress), { initialProps: { inAddress: undefined as boolean | undefined } });
    expect(result.current).toEqual({ active: false, toggle: undefined });
    config.data = { booksEnabled: false };
    rerender({ inAddress: undefined });
    expect(result.current).toEqual({ active: false, toggle: undefined });
    expect(navigate).not.toHaveBeenCalled();
  });
  it("option coupée et `#livres=1` restée dans l'adresse : le mode en est retiré", () => {
    config.data = { booksEnabled: false };
    const { result } = renderHook(() => useBooksMode(true));
    expect(result.current.active).toBe(false);
    expect(navigate).toHaveBeenCalledWith({ books: false, book: null, reading: false, booksAll: null }, "replace");
  });
  it("option allumée : entrer et sortir écrivent le mode dans l'adresse, l'onglet seulement en sortant", () => {
    config.data = { booksEnabled: true };
    const { result } = renderHook(() => useBooksMode(true));
    expect(result.current.active).toBe(true);
    result.current.toggle!.onSelect();
    expect(navigate).toHaveBeenLastCalledWith({ books: true, film: null, serie: null }, "replace");
    result.current.toggle!.onLeave("series");
    expect(navigate).toHaveBeenLastCalledWith({ books: false, booksAll: null, tab: "series", film: null, serie: null }, "replace");
  });
});

describe("la recherche de l'application", () => {
  it("option coupée : la section « Livres » ne rend rien, ne charge rien et ne demande rien", async () => {
    for (const data of [undefined, { booksEnabled: false }]) {
      config.data = data;
      const { container } = render(<BooksSearchEntry query="cherub" />);
      expect(container.innerHTML).toBe("");
      cleanup();
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(searchLoaded).not.toHaveBeenCalled();
    // La seule clé lue : la configuration publique, déjà en cache pour tout l'accueil.
    expect(new Set(config.keys)).toEqual(new Set(["/api/config/public"]));
  });
});

describe("l'adresse du cinéma", () => {
  it("sans `livres` : aucune trace dans la route ; avec : le mode, et `tab` inchangé", async () => {
    const { readCinemaRoute } = await vi.importActual<typeof import("@/lib/cinemaRoute")>("@/lib/cinemaRoute");
    window.location.hash = "#tab=series";
    expect("books" in readCinemaRoute()).toBe(false);
    expect(readCinemaRoute().tab).toBe("series");
    window.location.hash = "#tab=series&livres=1";
    expect(readCinemaRoute()).toMatchObject({ tab: "series", books: true });
    window.location.hash = "";
  });
});
