// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { HeroBackdrop } from "@/components/cinema/HeroBackdrop";

/**
 * Le fond de l'accueil du bureau passait par le noir à chaque titre : l'ancien visuel était
 * démonté d'un coup, le nouveau fondait depuis l'encre, avant même d'être chargé (23/09/2026).
 */
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const layers = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLElement>("[data-hero-layer]")].map((l) => ({
    src: l.querySelector("img")?.getAttribute("src") ?? null,
    state: l.dataset.heroLayer,
  }));
const sharpImg = (c: HTMLElement, src: string) =>
  [...c.querySelectorAll<HTMLImageElement>(`img[src="${src}"]`)].find((i) => !i.className.includes("blur"))!;

/** La fin d'un fondu : le composant retire le dessous par un minuteur calé sur sa durée. */
function endFade() {
  act(() => void vi.advanceTimersByTime(300));
}

function show(c: HTMLElement, src: string) {
  fireEvent.load(sharpImg(c, src));
  endFade();
}

describe("HeroBackdrop", () => {
  it("n'apparaît qu'une fois son image chargée", () => {
    const { container } = render(<HeroBackdrop src="/a.jpg" id={1} mask="none" />);
    expect(layers(container)).toEqual([{ src: "/a.jpg", state: "loading" }]);
    fireEvent.load(sharpImg(container, "/a.jpg"));
    expect(layers(container)).toEqual([{ src: "/a.jpg", state: "shown" }]);
  });

  it("garde l'ancien visuel sous le nouveau jusqu'à la fin du fondu", () => {
    const { container, rerender } = render(<HeroBackdrop src="/a.jpg" id={1} mask="none" />);
    show(container, "/a.jpg");
    rerender(<HeroBackdrop src="/b.jpg" id={2} mask="none" />);
    // Le passage par le noir : l'ancien visuel ne doit pas disparaître avant que le nouveau soit là.
    expect(layers(container)).toEqual([
      { src: "/a.jpg", state: "shown" },
      { src: "/b.jpg", state: "loading" },
    ]);
    fireEvent.load(sharpImg(container, "/b.jpg"));
    act(() => void vi.advanceTimersByTime(100)); // en plein fondu
    expect(layers(container).map((l) => l.src)).toEqual(["/a.jpg", "/b.jpg"]);
    endFade();
    expect(layers(container)).toEqual([{ src: "/b.jpg", state: "shown" }]);
  });

  it("remplace un visuel encore en attente au lieu de l'empiler", () => {
    const { container, rerender } = render(<HeroBackdrop src="/a.jpg" id={1} mask="none" />);
    show(container, "/a.jpg");
    rerender(<HeroBackdrop src="/b.jpg" id={2} mask="none" />);
    rerender(<HeroBackdrop src="/c.jpg" id={3} mask="none" />);
    expect(layers(container).map((l) => l.src)).toEqual(["/a.jpg", "/c.jpg"]);
  });

  it("revenir au visuel affiché avant que le suivant ait chargé ne fait rien fondre", () => {
    const { container, rerender } = render(<HeroBackdrop src="/a.jpg" id={1} mask="none" />);
    show(container, "/a.jpg");
    rerender(<HeroBackdrop src="/b.jpg" id={2} mask="none" />);
    rerender(<HeroBackdrop src="/a.jpg" id={1} mask="none" />);
    expect(layers(container)).toEqual([{ src: "/a.jpg", state: "shown" }]);
  });

  it("ne retire pas le visuel du dessous en plein fondu", () => {
    const { container, rerender } = render(<HeroBackdrop src="/a.jpg" id={1} mask="none" />);
    show(container, "/a.jpg");
    rerender(<HeroBackdrop src="/b.jpg" id={2} mask="none" />);
    fireEvent.load(sharpImg(container, "/b.jpg")); // b fond, pas encore fini
    rerender(<HeroBackdrop src="/c.jpg" id={3} mask="none" />);
    expect(layers(container).map((l) => l.src)).toEqual(["/a.jpg", "/b.jpg", "/c.jpg"]);
  });

  it("un visuel introuvable ne retient pas le fond sur le titre d'avant", () => {
    const { container, rerender } = render(<HeroBackdrop src="/a.jpg" id={1} mask="none" />);
    show(container, "/a.jpg");
    rerender(<HeroBackdrop src="/absent.jpg" id={2} mask="none" />);
    fireEvent.error(sharpImg(container, "/absent.jpg"));
    expect(layers(container).at(-1)).toEqual({ src: "/absent.jpg", state: "shown" });
  });

  it("un titre sans visuel fond aussitôt vers l'encre", () => {
    const { container, rerender } = render(<HeroBackdrop src="/a.jpg" id={1} mask="none" />);
    show(container, "/a.jpg");
    rerender(<HeroBackdrop src={null} id={2} mask="none" />);
    expect(layers(container).at(-1)).toEqual({ src: null, state: "shown" });
  });
});
