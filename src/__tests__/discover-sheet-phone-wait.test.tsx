// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, act, waitFor } from "@testing-library/react";
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
let calls = 0;
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: (key: string) => {
    if (!key.startsWith("/api/player/title/")) return Promise.resolve({});
    calls++;
    return new Promise((ok) => (answer = ok));
  },
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
        requestState: null, watchlistStatus: null, downloading: null, watched: false, posterPath: null, logo: null, logoPending: false,
      });
    });
    // Le même bloc reçoit la réponse, en fondu ; la roue est partie.
    expect(document.body.querySelector("[data-sheet-content]")).toBe(content);
    expect(await screen.findByText("Le synopsis.")).toBeTruthy();
    expect(document.body.querySelector(".animate-spin")).toBeNull();
    expect(content!.querySelector(".animate-fade-in")).not.toBeNull();
  });
});

const ANSWER = {
  tmdbId: 13475, type: "movie", title: "Star Trek", year: 2009, releaseDate: "2009-05-06", overview: "Kirk.",
  tagline: null, poster: null, backdrop: null, genres: [], runtime: 127, rating: 7.4, cast: [], libraryId: null,
  requestState: null, watchlistStatus: null, downloading: null, watched: false, posterPath: null,
};
const LOGO = "/_next/image?url=logo-star-trek.png&w=640&q=75";

/**
 * Huitième film (06/11/2026) : la réponse partie sans son logo (encore en calcul) le gardait pour de
 * bon — titre écrit à chaque réouverture, SWR resservant la même réponse.
 */
describe("fiche découverte, téléphone — le logo arrivé après la réponse", () => {
  it("le titre écrit tient la place du logo, puis le logo paraît en fondu dans la même fiche ; rouverte, elle l'a d'emblée", async () => {
    const cache = new Map();
    const mount = () =>
      render(
        <SWRConfig value={{ provider: () => cache, dedupingInterval: 10_000 }}>
          <PlayerDiscoverSheet tmdbId={13475} mediaType="movie" />
        </SWRConfig>
      );
    const first = mount();
    await act(async () => {
      answer({ ...ANSWER, logo: null, logoPending: true });
    });
    const before = calls;
    const content = document.body.querySelector<HTMLElement>("[data-sheet-content]")!;
    // Le titre écrit, dans une place tenue à la hauteur du logo.
    const heading = await screen.findByRole("heading", { name: "Star Trek" });
    expect(heading.closest(".min-h-13")).not.toBeNull();
    // La fiche redemande sa réponse d'elle-même — le logo est arrivé côté serveur.
    await waitFor(() => expect(calls).toBeGreaterThan(before), { timeout: 3000 });
    await act(async () => {
      answer({ ...ANSWER, logo: LOGO, logoPending: false });
    });
    const logo = await waitFor(() => {
      const img = content.querySelector<HTMLImageElement>(`img[src="${LOGO}"]`);
      expect(img).not.toBeNull();
      return img!;
    });
    // En fondu, dans la même place : la colonne ne saute pas.
    expect(logo.closest(".animate-fade-in")).not.toBeNull();
    expect(logo.closest(".min-h-13")).not.toBeNull();
    first.unmount();
    // Rouverte dans la même séance : la réponse gardée porte le logo, montré d'emblée, sans fondu.
    mount();
    const again = document.body.querySelector<HTMLElement>("[data-sheet-content]")!;
    expect(again.querySelector(`img[src="${LOGO}"]`)).not.toBeNull();
  });
});
