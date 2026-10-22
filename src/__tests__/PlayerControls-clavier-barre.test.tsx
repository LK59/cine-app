// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act, fireEvent, within } from "@testing-library/react";
import { useRef, type RefObject } from "react";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

import { PlayerControls } from "@/components/PlayerControls";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const noop = () => {};

function Harness(props: Partial<React.ComponentProps<typeof PlayerControls>> & { onVideoRef?: (v: HTMLVideoElement) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={containerRef}>
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
        title="Un titre"
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

/** Un film de dix minutes, à 100 s, dont la position est assignable (jsdom ne l'est pas d'office). */
async function withPosition(video: HTMLVideoElement) {
  Object.defineProperty(video, "duration", { value: 600, configurable: true });
  Object.defineProperty(video, "currentTime", { value: 100, writable: true, configurable: true });
  await act(async () => void video.dispatchEvent(new Event("durationchange")));
  await act(async () => void video.dispatchEvent(new Event("timeupdate")));
}

describe("PlayerControls — Début, Fin, Page préc./suiv., ↑ ↓ sur la barre focalisée", () => {
  // Seules ← et → sautaient (±10 s, l'écouteur de la fenêtre). Les autres touches qu'un curseur
  // natif comprend déplaçaient la valeur de l'input : l'aperçu suivait, puis le tic suivant le
  // ramenait à la vraie position, sans aucun saut (audit du lecteur, 22/10/2026).
  async function setup(props: Partial<React.ComponentProps<typeof PlayerControls>> = {}) {
    stubMediaFetches();
    let video: HTMLVideoElement | null = null;
    const { container } = render(<Harness {...props} onVideoRef={(v) => (video = v)} />);
    await withPosition(video!);
    const seek = container.querySelector<HTMLInputElement>('[data-player-nav="seek"]')!;
    seek.focus();
    return { video: video!, seek };
  }
  async function press(seek: HTMLInputElement, key: string) {
    const event = new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true });
    await act(async () => void seek.dispatchEvent(event));
    return event;
  }

  it("Début revient au commencement, Fin va à la fin, par le même saut que les flèches", async () => {
    const onSeekRequest = vi.fn();
    const { video, seek } = await setup({ onSeekRequest });
    const home = await press(seek, "Home");
    expect(home.defaultPrevented).toBe(true);
    expect(video.currentTime).toBe(0);
    expect(onSeekRequest).toHaveBeenLastCalledWith(0);
    const end = await press(seek, "End");
    expect(end.defaultPrevented).toBe(true);
    expect(video.currentTime).toBe(600);
    expect(onSeekRequest).toHaveBeenLastCalledWith(600);
  });

  it("Page suiv. avance d'une minute, Page préc. recule d'une minute", async () => {
    const { video, seek } = await setup();
    expect((await press(seek, "PageUp")).defaultPrevented).toBe(true);
    expect(video.currentTime).toBeCloseTo(160, 1);
    expect((await press(seek, "PageDown")).defaultPrevented).toBe(true);
    expect(video.currentTime).toBeCloseTo(100, 1);
  });

  it("↑ et ↓ ne bougent ni la barre ni le film : ils ne font que montrer les commandes", async () => {
    const onSeekRequest = vi.fn();
    const { video, seek } = await setup({ onSeekRequest });
    expect((await press(seek, "ArrowUp")).defaultPrevented).toBe(true);
    expect((await press(seek, "ArrowDown")).defaultPrevented).toBe(true);
    expect(video.currentTime).toBe(100);
    expect(onSeekRequest).not.toHaveBeenCalled();
  });

  it("un lecteur suspendu ne saute pas, et l'input ne bouge pas seul", async () => {
    const onSeekRequest = vi.fn();
    const { video, seek } = await setup({ suspended: true, onSeekRequest });
    expect((await press(seek, "End")).defaultPrevented).toBe(true);
    expect(video.currentTime).toBe(100);
    expect(onSeekRequest).not.toHaveBeenCalled();
  });
});
