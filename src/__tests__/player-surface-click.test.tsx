// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { useRef, type RefObject } from "react";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

import { PlayerControls } from "@/components/PlayerControls";
import { sleepTimerStore } from "@/lib/sleepTimer";

/**
 * Le clic sur l'image (DECISIONS.md §65, 11/10/2026) : la souris met en pause, le doigt et le
 * stylet montrent les commandes — décidé par l'appui, pas par l'appareil. Et le bouton « Épisode
 * suivant » de la barre du bas, et « Passer le récap ».
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  sleepTimerStore.clear();
});

const noop = () => {};

/** Un élément vidéo dont `paused` suit vraiment `play()` et `pause()`. */
function controllableVideo(v: HTMLVideoElement) {
  let paused = true;
  Object.defineProperty(v, "paused", { get: () => paused, configurable: true });
  v.play = vi.fn(() => {
    paused = false;
    return Promise.resolve();
  });
  v.pause = vi.fn(() => {
    paused = true;
  });
}

function Harness(props: Partial<React.ComponentProps<typeof PlayerControls>> & { onVideoRef?: (v: HTMLVideoElement) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={containerRef} data-testid="container">
      <video
        ref={(el) => {
          videoRef.current = el;
          if (el && props.onVideoRef) props.onVideoRef(el);
        }}
      />
      <PlayerControls
        videoRef={videoRef as RefObject<HTMLVideoElement | null>}
        containerRef={containerRef}
        itemId="item-1"
        title="Some Title"
        onClose={noop}
        onMinimize={noop}
        onTogglePlaybackInfo={noop}
        audioTracks={[]}
        currentAudioId={null}
        onChangeAudio={noop}
        subtitleTracks={[]}
        currentSubtitleId={null}
        onChangeSubtitle={noop}
        hidden={false}
        loading={false}
        introSkip={null}
        creditsStart={null}
        nextEpisode={null}
        onAdvance={noop}
        {...props}
      />
    </div>
  );
}

function stubMediaFetches() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => null }));
}

/** Un appui, avec son type — un PointerEvent que jsdom ne sait pas construire avec `pointerType`. */
function press(el: Element, pointerType: string) {
  const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(down, "pointerType", { value: pointerType });
  el.dispatchEvent(down);
}

/** Un clic complet : l'appui, puis le `click` (qui, lui, ne dit pas toujours son type). */
async function clickWith(el: Element, pointerType: string, detail = 1) {
  await act(async () => {
    press(el, pointerType);
    fireEvent.click(el, { detail });
  });
}

const surface = (container: HTMLElement) => container.querySelector(".player-liquid")!;
const controlsShown = (container: HTMLElement) =>
  container.querySelector('[data-player-navgroup="topbar"]')!.className.includes("pointer-events-auto");

async function setup(props: Partial<React.ComponentProps<typeof PlayerControls>> = {}) {
  stubMediaFetches();
  let video!: HTMLVideoElement;
  const utils = render(
    <Harness
      {...props}
      onVideoRef={(v) => {
        video = v;
        controllableVideo(v);
      }}
    />
  );
  await act(async () => {});
  return { ...utils, video };
}

describe("le clic sur l'image", () => {
  it("à la souris, met en pause et relance — les commandes restent visibles", async () => {
    const { container, video } = await setup();
    await clickWith(surface(container), "mouse");
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(controlsShown(container)).toBe(true);
    await clickWith(surface(container), "mouse");
    expect(video.pause).toHaveBeenCalledTimes(1);
  });

  it("au doigt, montre ou cache les commandes, sans toucher à la lecture", async () => {
    const { container, video } = await setup();
    expect(controlsShown(container)).toBe(true);
    await clickWith(surface(container), "touch");
    expect(controlsShown(container)).toBe(false);
    await clickWith(surface(container), "touch");
    expect(controlsShown(container)).toBe(true);
    expect(video.play).not.toHaveBeenCalled();
    expect(video.pause).not.toHaveBeenCalled();
  });

  it("au doigt sur iPhone/iPad, même quand le `click` se déclare « mouse » : commandes, jamais pause", async () => {
    // WebKit iOS (11/10/2026) : le tap envoie un `pointerdown` « touch », puis un `click` dont le
    // `pointerType` vaut « mouse ». Lu sur le `click`, chaque toucher de l'image mettait en pause.
    const { container, video } = await setup();
    const tap = async () => {
      await act(async () => {
        press(surface(container), "touch");
        const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 });
        Object.defineProperty(click, "pointerType", { value: "mouse" });
        surface(container).dispatchEvent(click);
      });
    };
    expect(controlsShown(container)).toBe(true);
    await tap();
    expect(controlsShown(container)).toBe(false);
    await tap();
    expect(controlsShown(container)).toBe(true);
    expect(video.play).not.toHaveBeenCalled();
    expect(video.pause).not.toHaveBeenCalled();
  });

  it("au stylet, comme au doigt", async () => {
    const { container, video } = await setup();
    await clickWith(surface(container), "pen");
    expect(controlsShown(container)).toBe(false);
    expect(video.play).not.toHaveBeenCalled();
  });

  it("un PC à écran tactile : la souris met en pause, le doigt montre les commandes, sur le même appareil", async () => {
    const { container, video } = await setup();
    await clickWith(surface(container), "mouse");
    expect(video.play).toHaveBeenCalledTimes(1);
    await clickWith(surface(container), "touch");
    // Le doigt n'a rien relancé ni arrêté : il a caché les commandes.
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.pause).not.toHaveBeenCalled();
    expect(controlsShown(container)).toBe(false);
    await clickWith(surface(container), "mouse");
    expect(video.pause).toHaveBeenCalledTimes(1);
  });

  it("un clic qui ne dit pas son type (navigateur ancien) suit l'appui qui l'a précédé", async () => {
    const { container, video } = await setup();
    await clickWith(surface(container), "mouse");
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it("un clic sans appui connu garde l'ancien geste : afficher / masquer", async () => {
    const { container, video } = await setup();
    await act(async () => void fireEvent.click(surface(container)));
    expect(controlsShown(container)).toBe(false);
    expect(video.play).not.toHaveBeenCalled();
  });

  it("double-clic à la souris : plein écran, et la lecture revient à son état d'avant", async () => {
    Object.defineProperty(document, "fullscreenEnabled", { value: true, configurable: true });
    const { container, video, getByTestId } = await setup();
    const box = getByTestId("container");
    box.requestFullscreen = vi.fn(() => Promise.resolve());
    const root = surface(container);
    await clickWith(root, "mouse", 1);
    await clickWith(root, "mouse", 2);
    await act(async () => void fireEvent.doubleClick(root));
    expect(box.requestFullscreen).toHaveBeenCalledTimes(1);
    // Mis en lecture puis rendu à la pause : l'état d'avant le double-clic.
    expect(video.paused).toBe(true);
    // Un troisième clic du même geste ne rebascule rien.
    await clickWith(root, "mouse", 3);
    expect(video.paused).toBe(true);
    Object.defineProperty(document, "fullscreenEnabled", { value: false, configurable: true });
  });

  it("double-tap au doigt : jamais de plein écran", async () => {
    Object.defineProperty(document, "fullscreenEnabled", { value: true, configurable: true });
    const { container, getByTestId } = await setup();
    const box = getByTestId("container");
    box.requestFullscreen = vi.fn(() => Promise.resolve());
    const root = surface(container);
    await clickWith(root, "touch", 1);
    await clickWith(root, "touch", 2);
    await act(async () => void fireEvent.doubleClick(root));
    expect(box.requestFullscreen).not.toHaveBeenCalled();
    Object.defineProperty(document, "fullscreenEnabled", { value: false, configurable: true });
  });

  it("double-tap au doigt sur iPhone/iPad (`click` déclarés « mouse ») : ni plein écran ni pause", async () => {
    Object.defineProperty(document, "fullscreenEnabled", { value: true, configurable: true });
    const { container, video, getByTestId } = await setup();
    const box = getByTestId("container");
    box.requestFullscreen = vi.fn(() => Promise.resolve());
    const root = surface(container);
    for (const detail of [1, 2]) {
      await act(async () => {
        press(root, "touch");
        const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail });
        Object.defineProperty(click, "pointerType", { value: "mouse" });
        root.dispatchEvent(click);
      });
    }
    await act(async () => void fireEvent.doubleClick(root));
    expect(box.requestFullscreen).not.toHaveBeenCalled();
    expect(video.play).not.toHaveBeenCalled();
    expect(video.pause).not.toHaveBeenCalled();
    Object.defineProperty(document, "fullscreenEnabled", { value: false, configurable: true });
  });

  it("appui sur un bouton, glissé, relâché sur l'image : ni pause ni lecture (11/10/2026)", async () => {
    // L'effet liquide suit le curseur ; relâché hors du bouton, le `click` part sur l'ancêtre commun.
    const { container, video } = await setup();
    await act(async () => {
      press(container.querySelector('[data-player-nav="more"]')!, "mouse");
      fireEvent.click(surface(container), { detail: 1 });
    });
    expect(video.play).not.toHaveBeenCalled();
    expect(video.pause).not.toHaveBeenCalled();
    // Le clic suivant, appuyé et relâché sur l'image, met bien en lecture.
    await clickWith(surface(container), "mouse");
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it("appui sur un bouton puis double-clic relâché sur l'image : pas de plein écran", async () => {
    Object.defineProperty(document, "fullscreenEnabled", { value: true, configurable: true });
    const { container, getByTestId } = await setup();
    const box = getByTestId("container");
    box.requestFullscreen = vi.fn(() => Promise.resolve());
    await act(async () => {
      press(container.querySelector('[data-player-nav="more"]')!, "mouse");
      fireEvent.doubleClick(surface(container));
    });
    expect(box.requestFullscreen).not.toHaveBeenCalled();
    Object.defineProperty(document, "fullscreenEnabled", { value: false, configurable: true });
  });

  it("au doigt, un appui commencé sur un bouton et relâché sur l'image garde son geste d'avant", async () => {
    const { container, video } = await setup();
    await act(async () => {
      press(container.querySelector('[data-player-nav="more"]')!, "touch");
      fireEvent.click(surface(container), { detail: 1 });
    });
    expect(controlsShown(container)).toBe(false);
    expect(video.play).not.toHaveBeenCalled();
  });

  it("un clic sur un bouton n'est pas un clic sur l'image", async () => {
    const { container, video } = await setup();
    await clickWith(container.querySelector('[data-player-nav="more"]')!, "mouse");
    expect(video.play).not.toHaveBeenCalled();
    expect(container.querySelector(".player-menu")).not.toBeNull();
  });

  it("un clic qui referme un menu ne met pas en pause", async () => {
    const { container, video } = await setup();
    await act(async () => void fireEvent.click(container.querySelector('[data-player-nav="more"]')!));
    expect(container.querySelector(".player-menu")).not.toBeNull();
    await clickWith(surface(container), "mouse");
    expect(container.querySelector(".player-menu")).toBeNull();
    expect(video.play).not.toHaveBeenCalled();
  });
});

describe("la souris quitte la fenêtre", () => {
  const leave = (pointerType: string, relatedTarget: EventTarget | null = null) => {
    const out = new MouseEvent("pointerout", { bubbles: true, relatedTarget });
    Object.defineProperty(out, "pointerType", { value: pointerType });
    window.dispatchEvent(out);
  };

  async function playing() {
    const r = await setup();
    await act(async () => {
      void r.video.play();
      r.video.dispatchEvent(new Event("play"));
    });
    expect(controlsShown(r.container)).toBe(true);
    return r;
  }

  it("pendant la lecture, les commandes partent aussitôt", async () => {
    const { container } = await playing();
    await act(async () => leave("mouse"));
    expect(controlsShown(container)).toBe(false);
  });

  it("un passage d'un élément à l'autre dans la page n'est pas une sortie", async () => {
    const { container } = await playing();
    await act(async () => leave("mouse", document.body));
    expect(controlsShown(container)).toBe(true);
  });

  it("jamais pour un doigt", async () => {
    const { container } = await playing();
    await act(async () => leave("touch"));
    expect(controlsShown(container)).toBe(true);
  });

  it("en pause, les commandes restent", async () => {
    const { container } = await setup();
    await act(async () => leave("mouse"));
    expect(controlsShown(container)).toBe(true);
  });

  it("un menu ouvert les retient", async () => {
    const { container } = await playing();
    await act(async () => void fireEvent.click(container.querySelector('[data-player-nav="more"]')!));
    await act(async () => leave("mouse"));
    expect(controlsShown(container)).toBe(true);
  });
});

describe("le bouton « Épisode suivant »", () => {
  const next = { itemId: "next-1", title: "S01E02" };

  it("n'existe pas pour un film ou un dernier épisode", async () => {
    const { container } = await setup();
    expect(container.querySelector('[data-player-nav="next-episode"]')).toBeNull();
  });

  it("lance l'épisode suivant par le chemin de la carte du générique", async () => {
    const onAdvance = vi.fn();
    const { container } = await setup({ nextEpisode: next, onAdvance });
    const button = container.querySelector('[data-player-nav="next-episode"]')!;
    expect(button.getAttribute("aria-label")).toBe("player.nextEpisode");
    // Dans la pilule des réglages, avec la même matière que ses voisins.
    expect(button.className).toContain("player-pill-btn");
    expect(button.closest("[data-settings-pill]")).not.toBeNull();
    await act(async () => void fireEvent.click(button));
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it("disparaît quand la minuterie arrête la série à la fin de cet épisode", async () => {
    const { container } = await setup({ nextEpisode: next });
    await act(async () => sleepTimerStore.choose("episode"));
    expect(container.querySelector('[data-player-nav="next-episode"]')).toBeNull();
  });
});

describe("« Passer le récap »", () => {
  it("paraît pendant le récap, puis « Passer l'intro » pendant l'intro, chacun menant à sa fin", async () => {
    const { video } = await setup({ recapSkip: { start: 6, end: 61 }, introSkip: { start: 324, end: 414 } });
    const at = async (t: number) => {
      Object.defineProperty(video, "currentTime", { value: t, writable: true, configurable: true });
      await act(async () => void video.dispatchEvent(new Event("timeupdate")));
    };
    await at(10);
    expect(screen.getByText("player.skipRecap")).toBeTruthy();
    expect(screen.queryByText("player.skipIntro")).toBeNull();
    await act(async () => void fireEvent.click(screen.getByText("player.skipRecap")));
    expect(video.currentTime).toBe(61);
    await at(330);
    expect(screen.getByText("player.skipIntro")).toBeTruthy();
    expect(screen.queryByText("player.skipRecap")).toBeNull();
    await at(500);
    expect(screen.queryByText("player.skipIntro")).toBeNull();
  });
});
