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
 * Chasse aux défauts, zone 3 (11/10/2026) — interactions du lecteur livrées avec §65. Chaque test
 * échoue sur le code au moment de la chasse ; harnais repris de player-surface-click.test.tsx.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  sleepTimerStore.clear();
  Object.defineProperty(document, "fullscreenEnabled", { value: false, configurable: true });
});

const noop = () => {};

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

function press(el: Element, pointerType: string) {
  const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(down, "pointerType", { value: pointerType });
  el.dispatchEvent(down);
}

async function clickWith(el: Element, pointerType: string, detail = 1) {
  await act(async () => {
    press(el, pointerType);
    fireEvent.click(el, { detail });
  });
}

const controlsShown = (container: HTMLElement) =>
  container.querySelector('[data-player-navgroup="topbar"]')!.className.includes("pointer-events-auto");

async function setup(props: Partial<React.ComponentProps<typeof PlayerControls>> = {}) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => null }));
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

async function playing(props: Partial<React.ComponentProps<typeof PlayerControls>> = {}) {
  const r = await setup(props);
  await act(async () => {
    void r.video.play();
    r.video.dispatchEvent(new Event("play"));
  });
  expect(controlsShown(r.container)).toBe(true);
  return r;
}

const leaveWindow = () => {
  const out = new MouseEvent("pointerout", { bubbles: true, relatedTarget: null });
  Object.defineProperty(out, "pointerType", { value: "mouse" });
  window.dispatchEvent(out);
};

describe("zone 3 — la souris quitte la fenêtre depuis la barre de progression", () => {
  it("les commandes partent aussitôt, même quand la souris sort par la barre (le bas de l'écran)", async () => {
    const { container } = await playing();
    const bar = container.querySelector("[data-player-elapsed]")!.nextElementSibling!;
    await act(async () => void fireEvent.mouseEnter(bar));
    // Sortie de la fenêtre : `pointerout` sans destination, puis les évènements souris de
    // compatibilité, dont le `mouseleave` de la barre — qui rappelle les commandes pour 5 s.
    await act(async () => {
      leaveWindow();
      fireEvent.mouseLeave(bar, { relatedTarget: null });
    });
    expect(controlsShown(container)).toBe(false);
  });
});

describe("zone 3 — un double-clic hors de l'image ne passe pas en plein écran", () => {
  async function withFullscreen(props: Partial<React.ComponentProps<typeof PlayerControls>>) {
    Object.defineProperty(document, "fullscreenEnabled", { value: true, configurable: true });
    const r = await setup(props);
    const box = r.getByTestId("container");
    box.requestFullscreen = vi.fn(() => Promise.resolve());
    return { ...r, box };
  }

  it("sur la carte « Épisode suivant » (son clic est arrêté, son double-clic non)", async () => {
    const { video, box } = await withFullscreen({ creditsStart: 100, nextEpisode: { itemId: "ep-2", title: "Épisode 2" } });
    Object.defineProperty(video, "duration", { value: 200, configurable: true });
    Object.defineProperty(video, "currentTime", { value: 150, writable: true, configurable: true });
    await act(async () => {
      video.dispatchEvent(new Event("durationchange"));
      video.dispatchEvent(new Event("timeupdate"));
    });
    const cardText = screen.getByText("Épisode 2");
    await clickWith(cardText, "mouse", 1);
    await clickWith(cardText, "mouse", 2);
    await act(async () => void fireEvent.doubleClick(cardText));
    expect(box.requestFullscreen).not.toHaveBeenCalled();
  });

  it("sur le titre de la barre du bas (son clic est arrêté, son double-clic non)", async () => {
    const { box } = await withFullscreen({});
    const title = screen.getByText("Some Title");
    await clickWith(title, "mouse", 1);
    await clickWith(title, "mouse", 2);
    await act(async () => void fireEvent.doubleClick(title));
    expect(box.requestFullscreen).not.toHaveBeenCalled();
  });
});

describe("zone 3 — un clic manqué de peu sur un bouton ne met pas en pause", () => {
  it("dans la marge de la pilule du haut (diffusion / mini-lecteur), la lecture ne bascule pas", async () => {
    const { container, video } = await setup();
    const pill = container.querySelector("[data-cast-pill]")!;
    await clickWith(pill, "mouse");
    expect(video.play).not.toHaveBeenCalled();
  });
});
