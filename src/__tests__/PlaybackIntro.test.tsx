// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, act, fireEvent } from "@testing-library/react";
import { PlaybackIntro, type IntroPhase } from "@/components/player/PlaybackIntro";
import { resetIntroClocks, startIntroClock, keepIntroSnapshot } from "@/lib/playbackIntro";

// jsdom n'a pas Web Animations : une doublure qui rend une animation finie.
beforeAll(() => {
  const finished = () => ({ id: "", playState: "finished", finished: Promise.resolve(), cancel() {} });
  Object.assign(Element.prototype, { animate: finished, getAnimations: () => [] });
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  resetIntroClocks();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const art = { name: "Alien", backdropUrl: "https://image.tmdb.org/t/p/original/fond.jpg", logoUrl: "https://image.tmdb.org/t/p/w500/logo.png" };

function Intro({ phase, startedAt = 10_000, onClose, clockKey }: { phase: IntroPhase; startedAt?: number; onClose?: () => void; clockKey?: string }) {
  return (
    <PlaybackIntro
      phase={phase}
      startedAt={startedAt}
      clockKey={clockKey}
      art={art}
      fallbackName="Alien"
      caption={["S1 · É3 · Le pari"]}
      onClose={onClose}
      closeLabel="Fermer"
      reduced={false}
    />
  );
}

const intro = () => document.querySelector("[data-playback-intro]");

describe("PlaybackIntro", () => {
  it("passage direct : une première image avant le seuil, et rien n'a jamais paru", () => {
    const { rerender } = render(<Intro phase="waiting" />);
    act(() => vi.advanceTimersByTime(200));
    expect(intro()).toBeNull();
    rerender(<Intro phase="picture" />);
    act(() => vi.advanceTimersByTime(1000));
    expect(intro()).toBeNull();
  });

  it("une attente réelle : passé 300 ms, le logo et la légende", () => {
    render(<Intro phase="waiting" />);
    act(() => vi.advanceTimersByTime(299));
    expect(intro()).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(intro()).not.toBeNull();
    expect(screen.getByAltText("Alien").getAttribute("src")).toBe(art.logoUrl);
    expect(screen.getByText("S1 · É3 · Le pari")).toBeTruthy();
    // Le fond net, en 1 280 px (jsdom : écran étroit).
    expect(document.querySelector("[data-playback-intro] img")?.getAttribute("src")).toBe("https://image.tmdb.org/t/p/w1280/fond.jpg");
  });

  it("la première image : fondu, puis le calque se retire", () => {
    const { rerender } = render(<Intro phase="waiting" />);
    act(() => vi.advanceTimersByTime(1500));
    rerender(<Intro phase="picture" />);
    expect(intro()).not.toBeNull();
    act(() => vi.advanceTimersByTime(400));
    expect(intro()).toBeNull();
  });

  it("une erreur : disparue à l'instant, sans fondu", () => {
    const { rerender } = render(<Intro phase="waiting" />);
    act(() => vi.advanceTimersByTime(1500));
    rerender(<Intro phase="gone" />);
    expect(intro()).toBeNull();
  });

  it("un relais après le seuil : l'ouverture est là d'emblée, avec ce que l'autre lecteur montrait", () => {
    startIntroClock("k", 8_000);
    keepIntroSnapshot("k", { art, name: "Alien", caption: ["Reprise à 1 h 12"] });
    render(<Intro phase="waiting" startedAt={8_000} clockKey="k" />);
    expect(intro()).not.toBeNull();
    expect(screen.getByText("Reprise à 1 h 12")).toBeTruthy();
  });

  it("ne prend aucun appui hors de sa croix", () => {
    const onClose = vi.fn();
    render(<Intro phase="waiting" onClose={onClose} />);
    act(() => vi.advanceTimersByTime(500));
    expect((intro() as HTMLElement).style.pointerEvents).toBe("none");
    fireEvent.click(screen.getByRole("button", { name: "Fermer" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
