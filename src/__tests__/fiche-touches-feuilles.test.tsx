// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * Les touches d'une fiche du bureau sous une feuille posée par-dessus (audit des fiches, 23/10/2026,
 * V1 et V2).
 *
 * La fenêtre « Partager » (comme « Télécharger » et la gestion d'un téléchargement) est une
 * `ActionSheet` portée dans `body`. Les fiches du bureau écoutaient Échap et Retour arrière sur
 * `window` sans regarder ni la cible ni la feuille : Retour arrière dans le champ « Pour qui »
 * n'effaçait pas la lettre et refermait la fiche ; Échap refermait la feuille *et* la fiche ; une
 * flèche envoyait le focus sur « Lire », derrière la feuille, et Entrée lançait le film.
 */
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: "idle", play: vi.fn() }) }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerEnabled: () => true, usePlayerEnabledState: () => true, usePlayerServerFallback: () => true }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k, useLocale: () => ({ locale: "fr" }) }));
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: () => new Promise(() => {}),
}));
vi.mock("@/lib/cinemaRoute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cinemaRoute")>()),
  arrivedByBack: () => false,
  useSheetBehind: () => false,
  useRouteBehind: () => null,
}));
vi.mock("@/lib/usePlayerSeriesRequests", () => ({ usePlayerSeriesRequests: () => ({ seasons: [], seasonOf: () => undefined }) }));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => false, useIsShortViewport: () => false, useIsTouch: () => false }));
vi.mock("@/lib/useWatchlistStatusMap", () => ({ useWatchlistStatusMap: () => ({}) }));
vi.mock("@/lib/useAddToWatchlist", () => ({
  canJoinWatchlist: (tmdbId: number | null | undefined) => !!tmdbId,
  useAddToWatchlist: () => ({ addedStatus: null, addToWatchlist: vi.fn(), removeFromWatchlist: vi.fn() }),
}));
vi.mock("@/lib/useJellyfinItemState", () => ({
  useJellyfinItemState: () => ({ progress: undefined, watched: false, known: true, busy: false, toggleWatched: vi.fn() }),
}));
vi.mock("@/lib/usePlaybackPrefetch", () => ({ usePlaybackPrefetch: () => {} }));
vi.mock("@/lib/missingFiles", () => ({ useFileMissing: () => false }));
vi.mock("@/components/cinema/CinemaSimilarRow", () => ({ useCinemaSimilar: () => [], CinemaSimilarRow: () => null, similarRowKeyNav: () => false }));
vi.mock("@/components/cinema/CinemaCollectionRow", () => ({
  useCinemaCollection: () => ({ parts: [] }),
  CinemaCollectionRow: () => null,
  CinemaMovieCollectionRow: () => null,
}));
vi.mock("@/components/cinema/CinemaMissingEpisodes", () => ({ CinemaMissingEpisodes: () => null }));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));
// L'administrateur : la pastille Partager n'est rendue que pour lui.
vi.mock("@/lib/useRole", () => ({ useRole: () => ({ isReadOnly: false, role: "admin", jfId: null, jfUser: null }) }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { CinemaMovieDetail } from "@/components/cinema/CinemaMovieDetail";
import { CinemaSeriesDetail } from "@/components/cinema/CinemaSeriesDetail";
import { ActionSheet } from "@/components/ActionSheet";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

const MOVIE = {
  radarrId: 3,
  tmdbId: 99,
  jellyfinItemId: "a".repeat(32),
  title: "Un film",
  year: 1973,
  posterUrl: null,
  backdropUrl: null,
  logoUrl: null,
  genres: [],
} as unknown as CinemaMovie;
const SERIES = {
  sonarrId: 7,
  tmdbId: 1234,
  jellyfinItemId: "b".repeat(32),
  title: "Une série",
  year: 1990,
  posterUrl: null,
  backdropUrl: null,
  logoUrl: null,
  genres: [],
} as unknown as CinemaSeries;

const withSwr = (node: React.ReactNode) => <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{node}</SWRConfig>;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const sheets = [
  ["la fiche film", (onClose: () => void) => <CinemaMovieDetail item={MOVIE} onClose={onClose} />],
  ["la fiche série", (onClose: () => void) => <CinemaSeriesDetail item={SERIES} onClose={onClose} />],
] as const;

/** Ouvre la fenêtre « Partager » de la fiche et rend son champ « Pour qui », focalisé. */
function openShare(): HTMLInputElement {
  const pill = document.body.querySelector<HTMLButtonElement>('button[aria-label="share.admin.button"]');
  expect(pill).not.toBeNull();
  fireEvent.click(pill!);
  act(() => vi.advanceTimersByTime(50));
  const input = document.body.querySelector<HTMLInputElement>("[data-action-sheet] input[type=text]");
  expect(input).not.toBeNull();
  input!.focus();
  return input!;
}

describe.each(sheets)("%s sous la fenêtre « Partager »", (_name, draw) => {
  it("Retour arrière dans le champ efface une lettre, et ne referme pas la fiche (V1)", () => {
    const onClose = vi.fn();
    render(withSwr(draw(onClose)));
    const input = openShare();
    // `fireEvent` rend faux quand un écouteur a annulé la touche : la lettre n'aurait pas été effacée.
    const notCancelled = fireEvent.keyDown(input, { key: "Backspace" });
    act(() => vi.runAllTimers());
    expect(notCancelled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Échap referme la feuille seule (V2)", () => {
    const onClose = vi.fn();
    render(withSwr(draw(onClose)));
    const input = openShare();
    fireEvent.keyDown(input, { key: "Escape" });
    act(() => vi.runAllTimers());
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.querySelector("[data-action-sheet]")).toBeNull();
  });

  it("une flèche reste dans la feuille, et n'envoie pas le focus sur « Lire » derrière elle (V2)", () => {
    render(withSwr(draw(vi.fn())));
    const input = openShare();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(document.activeElement).toBe(input);
  });
});

describe("une feuille ouverte garde ses touches (`ActionSheet`)", () => {
  // Les écouteurs de fiche posés sur `window`, en bulle : ce qu'ils entendraient sous la feuille.
  it("Échap, les flèches, Entrée et Retour arrière n'atteignent pas ce qui est dessous", () => {
    const heard: string[] = [];
    const listener = (e: KeyboardEvent) => heard.push(e.key);
    window.addEventListener("keydown", listener);
    document.addEventListener("keydown", listener);
    const onClose = vi.fn();
    try {
      render(<ActionSheet open onClose={onClose} actions={[{ label: "Une action", onClick: vi.fn() }]} />);
      act(() => vi.advanceTimersByTime(50));
      const action = document.body.querySelector<HTMLButtonElement>("[data-sheet-action]")!;
      for (const key of ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter", "Backspace"]) {
        // Arrêtées, pas annulées : le bouton, le groupe radio, le champ gardent leur geste.
        expect([key, fireEvent.keyDown(action, { key })]).toEqual([key, true]);
      }
      expect(heard).toEqual([]);
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.keyDown(action, { key: "Escape" });
      expect(heard).toEqual([]);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", listener);
      document.removeEventListener("keydown", listener);
    }
  });

  it("fermée, elle ne retient plus rien", () => {
    const heard: string[] = [];
    const listener = (e: KeyboardEvent) => heard.push(e.key);
    window.addEventListener("keydown", listener);
    try {
      render(<ActionSheet open={false} onClose={vi.fn()} actions={[{ label: "Une action", onClick: vi.fn() }]} />);
      fireEvent.keyDown(document.body, { key: "Escape" });
      fireEvent.keyDown(document.body, { key: "ArrowDown" });
      expect(heard).toEqual(["Escape", "ArrowDown"]);
    } finally {
      window.removeEventListener("keydown", listener);
    }
  });
});
