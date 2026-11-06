// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, act } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * La fiche découverte du téléphone en attendant sa réponse (06/11/2026, sixième film) : ~1,3 s d'écran
 * noir — une croix et une roue —, puis la fiche d'un coup, sans trajet depuis l'affiche. Elle s'ouvre
 * désormais sur ce que la carte savait (titre, année), dans son bloc de contenu, et le reste s'y dépose
 * quand la réponse arrive.
 */
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string) => k,
  useLocale: () => ({ locale: "fr" }),
}));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => true, useIsShortViewport: () => false, useIsTouch: () => true }));
vi.mock("@/lib/usePlayerTitleActions", () => ({
  usePlayerTitleActions: () => ({ busy: false, setStatus: vi.fn(), request: vi.fn(), cancelRequest: vi.fn() }),
}));
vi.mock("@/lib/useTitleWatched", () => ({ useTitleWatched: () => ({ watched: false, busy: false, toggle: vi.fn() }) }));
vi.mock("@/lib/cinemaRoute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cinemaRoute")>()),
  arrivedByBack: () => false,
  cinemaNavigate: vi.fn(),
}));

let answer: (value: unknown) => void = () => {};
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: (key: string) => (key.startsWith("/api/player/title/") ? new Promise((ok) => (answer = ok)) : Promise.resolve({})),
}));

import { PlayerDiscoverSheet } from "@/components/player/PlayerDiscoverSheet";
import { openDiscoveryItem } from "@/lib/cinemaOpen";

afterEach(cleanup);

describe("fiche découverte, téléphone — l'attente de la réponse", () => {
  it("s'ouvre sur le titre et l'année de la carte, dans son bloc de contenu, puis reçoit la réponse", async () => {
    openDiscoveryItem({ tmdbId: 1263337, type: "movie", title: "Un film loin", year: 2025, poster: null, libraryId: null });
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <PlayerDiscoverSheet tmdbId={1263337} mediaType="movie" />
      </SWRConfig>
    );
    // Le fond uni qui tient la place du visuel ne paraît qu'une fois la fiche posée : pendant le
    // trajet, c'était une bande sombre pleine largeur en haut de l'écran (septième film).
    expect(document.body.querySelector(".bg-surface")?.hasAttribute("data-sheet-settle")).toBe(true);
    const content = document.body.querySelector<HTMLElement>("[data-sheet-content]");
    // Le bloc que le trajet fait paraître existe dès le montage, avec ce que la carte savait.
    expect(content).not.toBeNull();
    expect(content!.textContent).toContain("Un film loin");
    expect(content!.textContent).toContain("2025");
    // La roue est dans le bloc, à la place des actions — plus seule sur un écran vide.
    expect(content!.querySelector(".animate-spin")).not.toBeNull();
    expect(document.body.querySelectorAll(".animate-spin")).toHaveLength(1);
    await act(async () => {
      answer({
        tmdbId: 1263337, type: "movie", title: "Un film loin", year: 2025, releaseDate: "2025-05-01", overview: "Le synopsis.",
        tagline: null, poster: null, backdrop: null, genres: [], runtime: 100, rating: 7, cast: [], libraryId: null,
        requestState: null, watchlistStatus: null, downloading: null, watched: false, posterPath: null, logo: null,
      });
    });
    // Le même bloc reçoit la réponse, en fondu ; la roue est partie.
    expect(document.body.querySelector("[data-sheet-content]")).toBe(content);
    expect(await screen.findByText("Le synopsis.")).toBeTruthy();
    expect(document.body.querySelector(".animate-spin")).toBeNull();
    expect(content!.querySelector(".animate-fade-in")).not.toBeNull();
  });
});
