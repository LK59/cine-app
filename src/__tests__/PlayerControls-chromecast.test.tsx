// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import { useRef, type RefObject } from "react";

// DECISIONS.md §64 — le bouton Chromecast des commandes : là seulement où l'hôte le donne, et rien
// de changé à AirPlay ni au bouton de diffusion du navigateur ailleurs.

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string) => key,
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

const nav = (container: HTMLElement, name: string) => container.querySelector<HTMLElement>(`[data-player-nav="${name}"]`);

describe("PlayerControls — le bouton Chromecast", () => {
  it("absent sans la propriété : les commandes sont exactement celles d'avant", async () => {
    stubMediaFetches();
    const { container } = render(<Harness />);
    await act(async () => {});
    expect(nav(container, "chromecast")).toBeNull();
  });

  it("présent quand l'hôte le donne ; un appui demande la session dans le geste même", async () => {
    stubMediaFetches();
    const onRequest = vi.fn();
    const { container } = render(<Harness chromecast={{ active: false, onRequest }} />);
    await act(async () => {});
    const button = nav(container, "chromecast")!;
    expect(button.getAttribute("aria-label")).toBe("player.chromecast.button");
    expect(button.hasAttribute("data-active")).toBe(false);
    fireEvent.click(button);
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it("marqué en service quand une session est ouverte", async () => {
    stubMediaFetches();
    const { container } = render(<Harness chromecast={{ active: true, onRequest: vi.fn() }} />);
    await act(async () => {});
    expect(nav(container, "chromecast")!.hasAttribute("data-active")).toBe(true);
  });

  it("AirPlay reste à côté, inchangé, avec sa confirmation", async () => {
    stubMediaFetches();
    const onCastRequest = vi.fn();
    const { container } = render(
      <Harness
        chromecast={{ active: false, onRequest: vi.fn() }}
        onCastRequest={onCastRequest}
        onVideoRef={(v) => {
          (v as HTMLVideoElement & { webkitShowPlaybackTargetPicker?: () => void }).webkitShowPlaybackTargetPicker = vi.fn();
        }}
      />
    );
    await act(async () => {});
    expect(nav(container, "cast")).not.toBeNull();
    fireEvent.click(nav(container, "cast")!);
    expect(container.querySelector("[data-cast-confirm]")!.getAttribute("data-cast-confirm")).toBe("open");
  });

  it("le bouton de diffusion du navigateur (Remote Playback) se tait derrière celui du Chromecast", async () => {
    stubMediaFetches();
    const withRemote = (v: HTMLVideoElement) => {
      Object.defineProperty(v, "remote", {
        configurable: true,
        value: { watchAvailability: (cb: (ok: boolean) => void) => (cb(true), Promise.resolve(1)), cancelWatchAvailability: () => Promise.resolve() },
      });
    };
    const alone = render(<Harness onVideoRef={withRemote} />);
    await act(async () => {});
    expect(nav(alone.container, "cast")).not.toBeNull();
    cleanup();
    const both = render(<Harness onVideoRef={withRemote} chromecast={{ active: false, onRequest: vi.fn() }} />);
    await act(async () => {});
    expect(nav(both.container, "cast")).toBeNull();
    expect(nav(both.container, "chromecast")).not.toBeNull();
  });
});
