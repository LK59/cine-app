// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, act, fireEvent } from "@testing-library/react";
import { PlaybackIntro, type IntroPhase } from "@/components/player/PlaybackIntro";
import { resetIntroClocks, startIntroClock, keepIntroSnapshot, introFinished, finishIntro } from "@/lib/playbackIntro";

// jsdom n'a pas Web Animations : une doublure qui rend une animation finie, et note chaque appel
// (cible, images clés, options) pour qu'un test puisse retrouver la lueur et savoir si elle a été annulée.
interface Played {
  target: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  cancel: ReturnType<typeof vi.fn>;
}
const played: Played[] = [];
beforeAll(() => {
  Object.assign(Element.prototype, {
    animate(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const cancel = vi.fn();
      played.push({ target: this, keyframes, options, cancel });
      return { id: "", playState: "finished", finished: Promise.resolve(), currentTime: 0, cancel };
    },
    getAnimations: () => [],
  });
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  resetIntroClocks();
  played.length = 0;
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
  caption = ["S1 · É3 · Le pari"],
}: {
  phase: IntroPhase;
  imageShown?: boolean;
  startedAt?: number;
  onClose?: () => void;
  onShow?: () => void;
  clockKey?: string;
  caption?: string[];
}) {
  return (
    <PlaybackIntro
      phase={phase}
      imageShown={imageShown}
      startedAt={startedAt}
      clockKey={clockKey}
      art={art}
      fallbackName="Alien"
      caption={caption}
      onClose={onClose}
      onShow={onShow}
      closeLabel="Fermer"
      reduced={false}
    />
  );
}

const layer = () => document.querySelector("[data-playback-intro]");
const sweepAnim = () => played.find((p) => JSON.stringify(p.keyframes).includes("translateX(-120%)"));
const logoAnim = () => played.find((p) => p.target.contains(screen.queryByAltText("Alien")) && JSON.stringify(p.keyframes).includes("scale(0.96)"));

describe("PlaybackIntro", () => {
  it("entière dès le premier rendu : le visuel, le logo, la ligne de chargement et la légende", () => {
    // Sous 300 ms, une couverture immobile sans logo se lisait comme une image figée sur les départs
    // les plus rapides (Louis, iPhone, 8.31.2) : plus de seuil, tout paraît à l'appui.
    const onShow = vi.fn();
    render(<Intro phase="waiting" onShow={onShow} />);
    expect(layer()?.getAttribute("data-playback-intro")).toBe("intro");
    expect(onShow).toHaveBeenCalledOnce();
    expect(document.querySelector("[data-playback-intro] img")?.getAttribute("src")).toBe("https://image.tmdb.org/t/p/w1280/fond.jpg");
    expect(screen.getByAltText("Alien").getAttribute("src")).toBe(art.logoUrl);
    expect(screen.getByText("S1 · É3 · Le pari")).toBeTruthy();
    expect(document.querySelector("[data-playback-intro-line]")).not.toBeNull();
  });

  it("le logo paraît dès l'appui, en 250 ms et sans délai ; la ligne avec lui ; le fond déjà en mouvement", () => {
    render(<Intro phase="waiting" />);
    const logo = logoAnim();
    expect(logo?.options.duration).toBe(250);
    expect(logo?.options.delay ?? 0).toBe(0);
    const details = played.find((p) => p.target.hasAttribute("data-playback-intro-details"));
    expect(details?.options.duration).toBe(250);
    expect(details?.options.delay ?? 0).toBe(0);
    expect(played.some((p) => JSON.stringify(p.keyframes).includes("scale(1.08)"))).toBe(true);
    // La lueur attend que le logo soit posé.
    expect(sweepAnim()?.options.delay).toBe(250);
  });

  it("un départ rapide : pas de couverture immobile, un seul fondu de 280 ms quand le film bouge", () => {
    // Une reprise lue depuis l'appareil : image décodée vers 50 ms, horloge partie vers 350 ms.
    const { rerender } = render(<Intro phase="waiting" clockKey="k" />);
    act(() => vi.advanceTimersByTime(50));
    rerender(<Intro phase="waiting" imageShown clockKey="k" />);
    act(() => vi.advanceTimersByTime(300));
    // L'image décodée ne retire rien : l'ouverture reste, logo et ligne compris.
    expect(layer()?.getAttribute("data-playback-intro")).toBe("intro");
    expect(introFinished("k")).toBe(false);
    rerender(<Intro phase="picture" imageShown clockKey="k" />);
    const fade = played.find((p) => p.target === layer() && JSON.stringify(p.keyframes).includes('"opacity":0'));
    expect(fade?.options.duration).toBe(280);
    act(() => vi.advanceTimersByTime(279));
    expect(layer()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(layer()).toBeNull();
    // Close pour cette lecture : un lecteur qui prendrait la relève ne recouvrirait pas l'image.
    expect(introFinished("k")).toBe(true);
  });

  it("le film part avant que le logo soit posé : la lueur ne passe pas", () => {
    const { rerender } = render(<Intro phase="waiting" />);
    act(() => vi.advanceTimersByTime(120));
    rerender(<Intro phase="picture" imageShown />);
    expect(sweepAnim()?.cancel).toHaveBeenCalled();
  });

  it("le film part une fois le logo posé : la lueur continue, emportée par le fondu", () => {
    const { rerender } = render(<Intro phase="waiting" />);
    act(() => vi.advanceTimersByTime(600));
    rerender(<Intro phase="picture" imageShown />);
    expect(sweepAnim()?.cancel).not.toHaveBeenCalled();
  });

  it("une image décodée qui ne part pas en 1,2 s : l'ouverture s'efface quand même, l'attente doit se voir", () => {
    const { rerender } = render(<Intro phase="waiting" clockKey="k" />);
    act(() => vi.advanceTimersByTime(50));
    rerender(<Intro phase="waiting" imageShown clockKey="k" />);
    act(() => vi.advanceTimersByTime(1199));
    expect(introFinished("k")).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(introFinished("k")).toBe(true);
    act(() => vi.advanceTimersByTime(280));
    expect(layer()).toBeNull();
  });

  it("sans image, une attente longue garde l'ouverture : la fin reste celle de l'hôte", () => {
    const { rerender } = render(<Intro phase="waiting" />);
    act(() => vi.advanceTimersByTime(4000));
    expect(layer()).not.toBeNull();
    rerender(<Intro phase="picture" imageShown />);
    act(() => vi.advanceTimersByTime(280));
    expect(layer()).toBeNull();
  });

  it("dit à l'hôte quand il couvre, pour qu'il taise la roue de ses commandes", () => {
    const covers: boolean[] = [];
    const onCoverChange = (c: boolean) => covers.push(c);
    const { rerender } = render(<PlaybackIntro phase="waiting" startedAt={10_000} art={art} fallbackName="Alien" caption={[]} onCoverChange={onCoverChange} reduced={false} />);
    expect(covers.at(-1)).toBe(true);
    rerender(<PlaybackIntro phase="picture" imageShown startedAt={10_000} art={art} fallbackName="Alien" caption={[]} onCoverChange={onCoverChange} reduced={false} />);
    // Dès le fondu de sortie : le film bouge, les vraies attentes reprennent leurs droits.
    expect(covers.at(-1)).toBe(false);
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

  it("une erreur : disparue à l'instant, sans fondu", () => {
    const { rerender } = render(<Intro phase="waiting" />);
    act(() => vi.advanceTimersByTime(1500));
    rerender(<Intro phase="gone" />);
    expect(layer()).toBeNull();
  });

  it("un relais : l'ouverture continue avec ce que l'autre lecteur montrait, au point où il en était", () => {
    startIntroClock("k", 8_000);
    keepIntroSnapshot("k", { art, name: "Alien", caption: ["Reprise à 1 h 12"] });
    render(<Intro phase="waiting" startedAt={8_000} clockKey="k" caption={["autre légende"]} />);
    expect(layer()?.getAttribute("data-playback-intro")).toBe("intro");
    expect(screen.getByText("Reprise à 1 h 12")).toBeTruthy();
    expect(screen.queryByText("autre légende")).toBeNull();
  });

  it("l'épisode suivant : son ouverture, avec la légende de l'épisode, dès l'appui", () => {
    // Un lecteur neuf par épisode : sans seuil, la légende est là à la première image dessinée.
    render(<Intro phase="waiting" clockKey="open-2:ep-4" caption={["S1 · É4 · La suite"]} />);
    expect(screen.getByText("S1 · É4 · La suite")).toBeTruthy();
  });

  it("ne prend aucun appui hors de sa croix, joignable dès l'appui", () => {
    const onClose = vi.fn();
    render(<Intro phase="waiting" onClose={onClose} />);
    expect((layer() as HTMLElement).style.pointerEvents).toBe("none");
    fireEvent.click(screen.getByRole("button", { name: "Fermer" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("un logo qui ne se charge pas laisse la place au titre écrit, pas à une image cassée", () => {
    render(<Intro phase="waiting" />);
    fireEvent.error(screen.getByAltText("Alien"));
    expect(screen.queryByAltText("Alien")).toBeNull();
    expect(screen.getByRole("heading", { name: "Alien" })).toBeTruthy();
  });

  it("« Réduire les animations » : logo et ligne posés en fondu simple, sans zoom ni lueur", () => {
    render(<PlaybackIntro phase="waiting" startedAt={10_000} art={art} fallbackName="Alien" caption={[]} reduced />);
    expect(played.some((p) => JSON.stringify(p.keyframes).includes("scale(1.08)"))).toBe(false);
    expect(sweepAnim()).toBeUndefined();
    expect(document.querySelector(".playback-intro-line")).toBeNull();
  });
});
