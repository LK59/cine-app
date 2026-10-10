// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * La fiche du téléphone, sous le lecteur.
 *
 * Elle reste montée sous le film pour que le refermer ramène là d'où l'on est parti — mais son
 * écouteur d'Échap, lui, restait branché : sur une tablette à clavier, une touche refermait le
 * lecteur *et* la fiche, deux crans d'historique d'un coup. Les fiches du bureau se taisaient déjà
 * (`playerOwnsKeyboard`) ; celle-ci non. Voir `playerHoldsKeyboard`.
 */
let mode: "idle" | "mini" | "full" = "idle";
const playMock = vi.fn();
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode, play: playMock }) }));
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
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => true, useIsShortViewport: () => false }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerEnabled: () => true, usePlayerEnabledState: () => true, usePlayerServerFallback: () => true }));
vi.mock("@/lib/useWatchlistStatusMap", () => ({ useWatchlistStatusMap: () => ({}) }));
vi.mock("@/lib/useAddToWatchlist", () => ({
  canJoinWatchlist: (tmdbId: number | null | undefined) => !!tmdbId,
  useAddToWatchlist: () => ({ addedStatus: null, addToWatchlist: vi.fn(), removeFromWatchlist: vi.fn() }),
}));
vi.mock("@/lib/useJellyfinItemState", () => ({
  useJellyfinItemState: () => ({ watched: false, known: true, busy: false, toggleWatched: vi.fn() }),
}));
vi.mock("@/lib/usePlayerSeriesRequests", () => ({ usePlayerSeriesRequests: () => ({ seasons: [], episodes: [] }) }));
vi.mock("@/components/cinema/CinemaSimilarRow", () => ({ useCinemaSimilar: () => [], CinemaSimilarRow: () => null }));
vi.mock("@/components/cinema/CinemaCollectionRow", () => ({ CinemaMovieCollectionRow: () => null }));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));

import { CinemaMobileDetail } from "@/components/cinema/mobile/CinemaMobileDetail";
import { clearMorphLayers, installFakeAnimations } from "./helpers/fakeAnimations";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import { RESUME_KEY } from "@/lib/swr";

const MOVIE = {
  radarrId: 1,
  tmdbId: 603,
  jellyfinItemId: "jf1",
  title: "Matrix",
  year: 1999,
  posterUrl: null,
  backdropUrl: null,
  logoUrl: null,
  genres: [],
  imdbRating: null,
} as unknown as CinemaMovie;

const draw = (onClose: () => void) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <CinemaMobileDetail item={MOVIE} mediaType="movies" onClose={onClose} />
    </SWRConfig>
  );
const root = () => document.body.querySelector<HTMLElement>(".phone-sheet-frame")!;

beforeEach(() => {
  mode = "idle";
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CinemaMobileDetail — le clavier", () => {
  it("se ferme à Échap quand elle est à l'écran", () => {
    const onClose = vi.fn();
    draw(onClose);
    fireEvent.keyDown(window, { key: "Escape" });
    act(() => vi.runAllTimers());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("se tait tant que le lecteur occupe l'écran", () => {
    mode = "full";
    const onClose = vi.fn();
    draw(onClose);
    fireEvent.keyDown(window, { key: "Escape" });
    act(() => vi.runAllTimers());
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("CinemaMobileDetail — la sortie", () => {
  // Un appui sur la bannière n'éteint pas l'animation de sortie des fermetures suivantes. Depuis le
  // 10/10/2026, cette sortie est la copie de la fiche que pose `useSheetMorph` (DECISIONS.md §61) :
  // elle doit toujours partir en mouvement, la vraie fiche cachée et l'adresse rendue.
  it("sort encore en mouvement après un appui sur la bannière", () => {
    const fake = installFakeAnimations();
    try {
      draw(vi.fn());
      const banner = document.body.querySelector<HTMLElement>(".aspect-video")!;
      fireEvent.pointerDown(banner, { clientY: 100, pointerId: 1, pointerType: "touch", button: 0 });
      fireEvent.pointerUp(banner, { clientY: 100, pointerId: 1, pointerType: "touch", button: 0 });
      fireEvent.click(document.body.querySelector('[aria-label="cinema.back"]')!);
      const copy = document.body.querySelector<HTMLElement>("[data-sheet-morph-layer] .sheet-morph-clone");
      expect(copy).not.toBeNull();
      expect(fake.created.some((a) => a.target === copy && !a.cancelled)).toBe(true);
      expect(document.body.querySelector<HTMLElement>("[data-sheet-morph-root]")!.style.visibility).toBe("hidden");
    } finally {
      fake.restore();
      clearMorphLayers();
    }
  });
});

// DECISIONS.md §61 : l'affiche touchée devient la bannière pendant que la carte monte, et la fiche y
// retourne. Ici à travers la vraie fiche : ses marques sont celles que `useSheetMorph` lit.
describe("CinemaMobileDetail — l'ouverture depuis une affiche", () => {
  it("part de l'affiche touchée sans sa propre entrée, et y revient à la croix", () => {
    const fake = installFakeAnimations();
    try {
      const card = document.createElement("button");
      const img = document.createElement("img");
      img.src = "https://img.test/matrix.jpg";
      card.appendChild(img);
      document.body.appendChild(card);
      fireEvent.pointerDown(img, { pointerId: 1, clientX: 5, clientY: 5 });
      fireEvent.pointerUp(img, { pointerId: 1, clientX: 5, clientY: 5 });

      render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <CinemaMobileDetail item={{ ...MOVIE, backdropUrl: "https://img.test/matrix-bd.jpg" } as CinemaMovie} mediaType="movies" onClose={vi.fn()} />
        </SWRConfig>
      );
      const sheet = document.body.querySelector<HTMLElement>("[data-sheet-morph-root]")!;
      // Le trajet mène l'entrée : plus de `sheet-in`, la bannière cachée sous la fenêtre qui vole.
      expect(sheet.className).not.toContain("sheet-in");
      expect(card.style.opacity).toBe("0");
      const layer = document.body.querySelector<HTMLElement>("[data-sheet-morph-layer]")!;
      expect(layer.nextElementSibling).toBe(sheet);
      expect(Array.from(layer.querySelectorAll("img")).map((i) => i.getAttribute("src"))).toEqual(
        expect.arrayContaining(["https://img.test/matrix.jpg", "https://img.test/matrix-bd.jpg"])
      );

      fireEvent.click(sheet.querySelector('[aria-label="cinema.back"]')!);
      expect(sheet.style.visibility).toBe("hidden");
      expect(layer.querySelector(".sheet-morph-clone")).not.toBeNull();
    } finally {
      fake.restore();
      clearMorphLayers();
    }
  });
});

// Règle 2 des fiches : un écran sur le départ n'a plus d'avis. Un appui sur un titre similaire
// pendant la sortie empilait une fiche par-dessus, et celle-ci ne se refermait plus (23/09/2026).
describe("CinemaMobileDetail — pendant sa sortie", () => {
  it("ne répond plus au doigt", () => {
    draw(vi.fn());
    expect(root().style.pointerEvents).toBe("");
    fireEvent.click(document.body.querySelector('[aria-label="cinema.back"]')!);
    expect(root().style.pointerEvents).toBe("none");
  });
});

/**
 * 25/09/2026 : la fiche s'ouvre complète. Ici le réseau ne répond jamais (`fetcher` reste en
 * attente) — tout ce qui s'affiche vient donc de l'appareil : le catalogue et « Reprendre ».
 */
describe("CinemaMobileDetail — ce que l'appareil sait, tout de suite", () => {
  const MIN = 60 * 10_000_000;
  const drawWithResume = () =>
    render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          dedupingInterval: 0,
          fallback: {
            [RESUME_KEY]: { items: [{ id: "jf1", positionTicks: 30 * MIN, runtimeTicks: 120 * MIN, cinemaHref: "/radarr/1" }] },
          },
        }}
      >
        <CinemaMobileDetail
          item={{ ...MOVIE, overview: "Le synopsis du catalogue", runtimeMinutes: 136 } as CinemaMovie}
          mediaType="movies"
          onClose={vi.fn()}
        />
      </SWRConfig>
    );

  it("la durée et le synopsis du catalogue, « Reprendre » de la reprise locale", () => {
    drawWithResume();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Le synopsis du catalogue");
    expect(text).toContain("2h16");
    expect(text).toContain("common.resume · cinema.timeRemaining");
  });

  it("ne décide pas de la position tant que Jellyfin n'a pas répondu", () => {
    playMock.mockClear();
    drawWithResume();
    const button = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes("common.resume"))!;
    fireEvent.click(button);
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(playMock.mock.calls[0][0]).toMatchObject({ itemId: "jf1" });
    expect(playMock.mock.calls[0][0].resumeAt).toBeUndefined();
  });

  it("tient la place de l'accroche, de la bande-annonce et de la distribution", () => {
    drawWithResume();
    expect(document.body.querySelectorAll("[data-sheet-reserved]").length).toBe(3);
  });
});

// 04/10/2026 : la croix en verre liquide, les boutons du corps avec le geste qui laisse défiler.
describe("CinemaMobileDetail — le verre et le geste des boutons", () => {
  it("met la croix en verre avec le geste complet, et le geste qui laisse défiler sur les boutons du corps", () => {
    draw(vi.fn());
    const close = document.body.querySelector<HTMLElement>('[aria-label="cinema.back"]')!;
    expect(close.hasAttribute("data-liquid")).toBe(true);
    expect(close.className).toContain("nav-glass");
    const pans = Array.from(root().querySelectorAll<HTMLElement>("[data-liquid-pan]"));
    // À voir et Vu au moins, en petits boutons ; aucun ne garde l'ancien enfoncement par `:active`.
    expect(pans.filter((b) => b.getAttribute("data-liquid-pan") === "icon").length).toBe(2);
    for (const b of pans) expect(b.className).not.toContain("active:scale-95");
  });

  it("anime la surface touchée, et laisse le clic à l'ancienne", () => {
    const animate = vi.fn(() => ({ id: "", cancel() {}, finished: Promise.resolve() }) as unknown as Animation);
    Object.defineProperty(HTMLElement.prototype, "animate", { value: animate, configurable: true });
    Object.defineProperty(HTMLElement.prototype, "getAnimations", { value: () => [], configurable: true });
    try {
      draw(vi.fn());
      const watched = root().querySelectorAll<HTMLElement>('[data-liquid-pan="icon"]')[1];
      fireEvent.pointerDown(watched, { button: 0, pointerId: 5, pointerType: "touch" });
      expect(animate.mock.contexts.at(-1)).toBe(watched);
      fireEvent.pointerUp(window, { pointerId: 5 });
    } finally {
      delete (HTMLElement.prototype as { animate?: unknown }).animate;
      delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations;
    }
  });
});
