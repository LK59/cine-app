// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, act, fireEvent } from "@testing-library/react";
import { PlaybackIntro, type IntroPhase } from "@/components/player/PlaybackIntro";
import { resetIntroClocks, startIntroClock, keepIntroSnapshot, introFinished, finishIntro } from "@/lib/playbackIntro";

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

function Intro({
  phase,
  imageShown,
  startedAt = 10_000,
  onClose,
  onShow,
  clockKey,
}: {
  phase: IntroPhase;
  imageShown?: boolean;
  startedAt?: number;
  onClose?: () => void;
  onShow?: () => void;
  clockKey?: string;
}) {
  return (
    <PlaybackIntro
      phase={phase}
      imageShown={imageShown}
      startedAt={startedAt}
      clockKey={clockKey}
      art={art}
      fallbackName="Alien"
      caption={["S1 · É3 · Le pari"]}
      onClose={onClose}
      onShow={onShow}
      closeLabel="Fermer"
      reduced={false}
    />
  );
}

const layer = () => document.querySelector("[data-playback-intro]");
const state = () => layer()?.getAttribute("data-playback-intro") ?? null;

describe("PlaybackIntro", () => {
  it("couvre le lecteur dès le premier rendu : le visuel sous son voile, sans logo ni légende", () => {
    // Le lecteur vide se voyait un instant à l'appui (10/10/2026) : la couverture est là d'emblée.
    render(<Intro phase="waiting" />);
    expect(state()).toBe("cover");
    expect(document.querySelector("[data-playback-intro] img")?.getAttribute("src")).toBe("https://image.tmdb.org/t/p/w1280/fond.jpg");
    expect(screen.queryByAltText("Alien")).not.toBeNull(); // le logo est monté, mais à l'opacité 0
    expect(screen.queryByText("S1 · É3 · Le pari")).toBeNull();
  });

  it("une première image avant le seuil : la couverture s'efface sur elle, l'ouverture animée ne paraît jamais", () => {
    // Le cas des reprises lues depuis l'appareil — ouvertes en 34 à 115 ms le 10/10/2026.
    const onShow = vi.fn();
    const { rerender } = render(<Intro phase="waiting" clockKey="k" onShow={onShow} />);
    act(() => vi.advanceTimersByTime(60));
    // Image là, horloge pas encore partie : l'hôte reste en `waiting`, l'image suffit.
    rerender(<Intro phase="waiting" imageShown clockKey="k" onShow={onShow} />);
    expect(state()).toBe("cover");
    act(() => vi.advanceTimersByTime(280));
    expect(layer()).toBeNull();
    act(() => vi.advanceTimersByTime(2000));
    expect(layer()).toBeNull();
    expect(onShow).not.toHaveBeenCalled();
    // Close pour cette lecture : un lecteur qui prendrait la relève ne recouvrirait pas l'image.
    expect(introFinished("k")).toBe(true);
  });

  it("une image arrivée avant le seuil annule l'ouverture même si l'hôte tarde à la retirer", () => {
    const { rerender } = render(<Intro phase="waiting" />);
    act(() => vi.advanceTimersByTime(200));
    rerender(<Intro phase="waiting" imageShown />);
    act(() => vi.advanceTimersByTime(150)); // passé 300 ms, pendant le fondu
    expect(state()).toBe("cover");
    expect(screen.queryByText("S1 · É3 · Le pari")).toBeNull();
  });

  it("rien à 300 ms : l'ouverture animée part de la couverture, logo et légende", () => {
    const onShow = vi.fn();
    render(<Intro phase="waiting" onShow={onShow} />);
    act(() => vi.advanceTimersByTime(299));
    expect(state()).toBe("cover");
    act(() => vi.advanceTimersByTime(1));
    expect(state()).toBe("intro");
    expect(onShow).toHaveBeenCalledOnce();
    expect(screen.getByAltText("Alien").getAttribute("src")).toBe(art.logoUrl);
    expect(screen.getByText("S1 · É3 · Le pari")).toBeTruthy();
    // Même image : la couverture ne change pas de fond en devenant l'ouverture.
    expect(document.querySelector("[data-playback-intro] img")?.getAttribute("src")).toBe("https://image.tmdb.org/t/p/w1280/fond.jpg");
  });

  it("l'ouverture animée parue : une image figée ne la retire pas, la fin reste celle de l'hôte", () => {
    const { rerender } = render(<Intro phase="waiting" />);
    act(() => vi.advanceTimersByTime(1500));
    rerender(<Intro phase="waiting" imageShown />);
    act(() => vi.advanceTimersByTime(1000));
    expect(state()).toBe("intro");
    rerender(<Intro phase="picture" imageShown />);
    expect(layer()).not.toBeNull();
    act(() => vi.advanceTimersByTime(400));
    expect(layer()).toBeNull();
  });

  it("une image déjà à l'écran n'est jamais recouverte : monté avec elle, rien du tout", () => {
    // Le mini-lecteur rendu au plein écran avant que l'horloge parte, par exemple.
    render(<Intro phase="waiting" imageShown />);
    act(() => vi.advanceTimersByTime(2000));
    expect(layer()).toBeNull();
  });

  it("une ouverture close ne reparaît pas dans le lecteur qui prend la relève", () => {
    startIntroClock("k", 9_900);
    finishIntro("k");
    render(<Intro phase="waiting" startedAt={9_900} clockKey="k" />);
    act(() => vi.advanceTimersByTime(2000));
    expect(layer()).toBeNull();
  });

  it("un passage direct du banc (`picture` avant le seuil) efface aussi la couverture", () => {
    const { rerender } = render(<Intro phase="waiting" />);
    act(() => vi.advanceTimersByTime(100));
    rerender(<Intro phase="picture" />);
    act(() => vi.advanceTimersByTime(280));
    expect(layer()).toBeNull();
  });

  it("une erreur : disparue à l'instant, sans fondu", () => {
    const { rerender } = render(<Intro phase="waiting" />);
    act(() => vi.advanceTimersByTime(1500));
    rerender(<Intro phase="gone" />);
    expect(layer()).toBeNull();
  });

  it("un relais après le seuil : l'ouverture est là d'emblée, avec ce que l'autre lecteur montrait", () => {
    startIntroClock("k", 8_000);
    keepIntroSnapshot("k", { art, name: "Alien", caption: ["Reprise à 1 h 12"] });
    render(<Intro phase="waiting" startedAt={8_000} clockKey="k" />);
    expect(state()).toBe("intro");
    expect(screen.getByText("Reprise à 1 h 12")).toBeTruthy();
  });

  it("un relais avant le seuil : la couverture continue, et l'ouverture part à l'heure de l'appui", () => {
    startIntroClock("k", 9_850);
    render(<Intro phase="waiting" startedAt={9_850} clockKey="k" />);
    expect(state()).toBe("cover");
    act(() => vi.advanceTimersByTime(150));
    expect(state()).toBe("intro");
  });

  it("ne prend aucun appui hors de sa croix, joignable dès la couverture", () => {
    const onClose = vi.fn();
    render(<Intro phase="waiting" onClose={onClose} />);
    expect((layer() as HTMLElement).style.pointerEvents).toBe("none");
    fireEvent.click(screen.getByRole("button", { name: "Fermer" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("un logo qui ne se charge pas laisse la place au titre écrit, pas à une image cassée", () => {
    render(<Intro phase="waiting" />);
    act(() => vi.advanceTimersByTime(300));
    fireEvent.error(screen.getByAltText("Alien"));
    expect(screen.queryByAltText("Alien")).toBeNull();
    expect(screen.getByRole("heading", { name: "Alien" })).toBeTruthy();
  });
});
