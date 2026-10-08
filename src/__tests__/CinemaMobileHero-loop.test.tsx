// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/components/cinema/CinemaLogo", () => ({ CinemaLogo: () => null }));

import { CinemaMobileHero } from "@/components/cinema/mobile/CinemaMobileHero";
import { CAROUSEL_TRANSITION } from "@/lib/useCarouselDrag";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

/**
 * La boucle de la bannière du téléphone (08/10/2026) :
 * - à deux titres, le sens d'un passage du second au premier était deviné — un pas en arrière
 *   faisait courir la piste deux cases vers l'avant ;
 * - le raccord sur le vrai titre faisait repousser l'affiche depuis 45 % d'opacité ;
 * - un titre retiré avant celui qu'on regarde faisait glisser la piste sans que rien ne change.
 */
let frames: FrameRequestCallback[] = [];
beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const flushFrame = () =>
  act(() => {
    const pending = frames;
    frames = [];
    pending.forEach((cb) => cb(0));
  });

const film = (n: number) =>
  ({ radarrId: n, title: `Film ${n}`, posterUrl: null, logoUrl: null, genres: [], year: 2000 }) as unknown as CinemaMovie;
const hero = (items: CinemaMovie[]) => (
  <CinemaMobileHero items={items} paused={false} short={false} onPlay={() => {}} onOpen={() => {}} />
);
const track = () => document.querySelector<HTMLElement>("section .flex[style*='transform']")!;
/** La case de la piste où elle est posée, lue dans sa transformation. */
const position = () => Number(track().style.transform.match(/\/ 2 - (-?\d+) \*/)?.[1]);
const slides = () => [...document.querySelectorAll<HTMLElement>(".hero-peek-slide")];
const bar = (title: string) => screen.getByRole("button", { name: title });

describe("CinemaMobileHero — la boucle", () => {
  it("à deux titres, la voisine de gauche du premier glisse vers la gauche, puis se raccorde sans transition", async () => {
    render(hero([film(1), film(2)]));
    // Deux copies de chaque côté : le premier titre est à la case 2.
    expect(position()).toBe(2);
    act(() => void fireEvent.click(slides()[1]));
    expect(position()).toBe(1);
    expect(track().style.transition).toBe(CAROUSEL_TRANSITION);

    // Le raccord attend le décodage des affiches d'arrivée (une promesse) : on la laisse finir.
    await act(async () => {
      fireEvent.transitionEnd(track(), { propertyName: "transform" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(position()).toBe(3);
    expect(track().style.transition).toBe("none");
    // L'affiche posée sur place ne refait pas son agrandissement.
    expect(slides()[3].className).toContain("hero-peek-on");
    expect(slides()[3].style.transition).toBe("none");
    flushFrame();
    expect(slides()[3].style.transition).toBe("");
  });

  it("à deux titres, un pas en arrière du second au premier glisse d'une case, sans faire le tour", () => {
    render(hero([film(1), film(2)]));
    act(() => void fireEvent.click(bar("Film 2")));
    flushFrame();
    expect(position()).toBe(3);
    // La voisine de gauche du second, c'est le premier : un pas en arrière.
    act(() => void fireEvent.click(slides()[2]));
    expect(position()).toBe(2);
    expect(track().style.transition).toBe(CAROUSEL_TRANSITION);
  });

  it("le tour vers l'avant de la rotation reste un glissement sur la copie", () => {
    render(hero([film(1), film(2), film(3)]));
    act(() => void fireEvent.click(bar("Film 3")));
    flushFrame();
    act(() => void fireEvent.click(slides()[5]));
    // Copie du premier, après le dernier.
    expect(position()).toBe(5);
    expect(track().style.transition).toBe(CAROUSEL_TRANSITION);
  });

  it("une barre touchée pendant le raccord part du vrai titre, sans glisser", () => {
    render(hero([film(1), film(2), film(3)]));
    act(() => void fireEvent.click(slides()[1]));
    expect(position()).toBe(1);
    act(() => void fireEvent.click(bar("Film 2")));
    expect(position()).toBe(3);
    expect(track().style.transition).toBe("none");
  });

  it("un titre retiré avant celui qu'on regarde ne fait pas glisser la piste", () => {
    const { rerender } = render(hero([film(1), film(2), film(3)]));
    act(() => void fireEvent.click(bar("Film 2")));
    flushFrame();
    expect(track().style.transition).toBe(CAROUSEL_TRANSITION);
    rerender(hero([film(2), film(3)]));
    expect(screen.getByRole("button", { name: "Film 2" }).getAttribute("aria-current")).toBe("true");
    expect(track().style.transition).toBe("none");
  });
});
