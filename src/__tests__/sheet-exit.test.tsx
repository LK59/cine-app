// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * Les deux fiches que la coquille garde montées pendant leur sortie — personne et découverte.
 *
 * La règle 2 de « The sheet lifecycle » (CLAUDE.md) : un écran qui s'en va n'a plus d'avis. Ces
 * deux fiches ferment tout de suite par `cinemaClose`, et la garde de celui-ci ne tient que jusqu'au
 * `popstate` du premier retour — un second Échap ou un second appui pendant les 280 ms de sortie
 * reculait donc d'un cran de plus et refermait la fiche *dessous*.
 *
 * Et deux défauts de la poignée, vus sur ces mêmes fiches : la croix posée dans la poignée
 * démarrait le geste, et un appui sur la poignée éteignait pour de bon l'animation de sortie.
 */
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string) => k,
  useLocale: () => ({ locale: "fr" }),
}));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => true, useIsShortViewport: () => false }));
// Rien n'arrive jamais : la bannière, sa croix et sa poignée sont là sans les données, et c'est
// tout ce qu'on regarde ici.
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: () => new Promise(() => {}),
}));
vi.mock("@/lib/usePlayerTitleActions", () => ({
  usePlayerTitleActions: () => ({ busy: false, setStatus: vi.fn(), request: vi.fn(), cancelRequest: vi.fn() }),
}));

const cinemaClose = vi.fn();
vi.mock("@/lib/cinemaRoute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cinemaRoute")>()),
  cinemaClose: (...a: unknown[]) => cinemaClose(...a),
  arrivedByBack: () => false,
}));

import { PlayerPersonSheet } from "@/components/player/PlayerPersonSheet";
import { PlayerDiscoverSheet } from "@/components/player/PlayerDiscoverSheet";

const wrap = (node: React.ReactNode) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{node}</SWRConfig>
);
const person = (leaving: boolean) => wrap(<PlayerPersonSheet tmdbId={1} leaving={leaving} />);
const discover = (leaving: boolean) => wrap(<PlayerDiscoverSheet tmdbId={2} mediaType="movie" leaving={leaving} />);

const escape = () => fireEvent.keyDown(window, { key: "Escape" });
/** La racine de la fiche découverte sur téléphone : elle porte l'animation. */
const discoverRoot = () => document.body.querySelector<HTMLElement>(".phone-sheet-frame")!;
/** Les poignées : la bannière de la fiche découverte, l'en-tête de la fiche personne. */
const discoverHandle = () => document.body.querySelector<HTMLElement>(".aspect-video")!;
const personHandle = () => document.body.querySelector<HTMLElement>('[role="dialog"] > div')!;
/** Un appui sur place, sans glissement — ce que fait un doigt qui touche la bannière. */
function tap(el: HTMLElement) {
  fireEvent.pointerDown(el, { clientY: 100, pointerId: 1, pointerType: "touch", button: 0 });
  fireEvent.pointerUp(el, { clientY: 100, pointerId: 1, pointerType: "touch", button: 0 });
}

beforeEach(() => cinemaClose.mockClear());
afterEach(cleanup);

describe("une fiche qui s'en va n'a plus d'avis", () => {
  it("fiche personne : ni Échap, ni voile, ni croix pendant sa sortie", () => {
    render(person(true));
    escape();
    act(() => (document.body.querySelector("[data-person-scrim]") as HTMLElement).click());
    act(() => (document.body.querySelector('[aria-label="common.close"]') as HTMLElement).click());
    expect(cinemaClose).not.toHaveBeenCalled();
  });

  it("fiche personne : ne reçoit plus le doigt pendant sa sortie", () => {
    render(person(true));
    const root = document.body.querySelector("[data-person-scrim]")!.parentElement as HTMLElement;
    expect(root.style.pointerEvents).toBe("none");
  });

  it("fiche personne : se ferme encore normalement tant qu'elle ne sort pas", () => {
    render(person(false));
    escape();
    expect(cinemaClose).toHaveBeenCalledTimes(1);
  });

  it("fiche découverte : ni Échap ni croix pendant sa sortie, et plus de doigt", () => {
    render(discover(true));
    escape();
    act(() => (document.body.querySelector('[aria-label="cinema.back"]') as HTMLElement).click());
    expect(cinemaClose).not.toHaveBeenCalled();
    expect(discoverRoot().style.pointerEvents).toBe("none");
  });

  it("fiche découverte : Échap la ferme tant qu'elle ne sort pas", () => {
    render(discover(false));
    escape();
    expect(cinemaClose).toHaveBeenCalledTimes(1);
  });
});

describe("la croix de la bannière n'est pas la poignée", () => {
  // La croix vit dans la poignée : sans arrêter l'appui, il démarrait le geste — et la poignée
  // prenait la capture, ce qui sur Chrome pour Android renvoie le clic ailleurs que sur la croix.
  it("fiche découverte : appuyer sur la croix ne démarre pas le geste", () => {
    render(discover(false));
    expect(discoverRoot().className).toContain("sheet-in");
    fireEvent.pointerDown(document.body.querySelector('[aria-label="cinema.back"]')!, {
      clientY: 20,
      pointerId: 1,
      pointerType: "touch",
      button: 0,
    });
    // Le geste aurait éteint l'entrée ; elle est toujours là.
    expect(discoverRoot().className).toContain("sheet-in");
  });
});

describe("un appui sur la poignée n'éteint pas la sortie", () => {
  // `touched` ne retombe jamais : les fiches s'en servaient pour taire `sheet-out`, si bien qu'après
  // un simple appui sur la bannière, chaque fermeture suivante disparaissait d'un coup.
  it("fiche découverte : la sortie glisse encore après un appui sur la bannière", () => {
    const { rerender } = render(discover(false));
    tap(discoverHandle());
    // Le geste a bien eu lieu : l'entrée est éteinte, comme elle doit l'être.
    expect(discoverRoot().className).not.toContain("sheet-in");
    rerender(discover(true));
    expect(discoverRoot().className).toContain("sheet-out");
  });

  it("fiche personne : pareil", () => {
    const { rerender } = render(person(false));
    tap(personHandle());
    expect(document.body.querySelector('[role="dialog"]')!.className).not.toContain("sheet-in");
    rerender(person(true));
    expect(document.body.querySelector('[role="dialog"]')!.className).toContain("sheet-out");
  });
});
