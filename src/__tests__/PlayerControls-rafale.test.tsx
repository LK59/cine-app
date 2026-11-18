// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import { useRef, type RefObject } from "react";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

import { PlayerControls } from "@/components/PlayerControls";

/**
 * Les rafales de ±10 s (18/11/2026) : chaque appui saute aussitôt ; un saut hors de la mémoire tampon ne retire plus
 * les trois boutons pour la roue, aucun chargement ne paraît dans la demi-seconde qui suit le dernier appui, et une
 * bulle additionne.
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function Harness({ onVideo }: { onVideo: (v: HTMLVideoElement) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const noop = () => {};
  return (
    <div ref={containerRef}>
      <video
        ref={(el) => {
          videoRef.current = el;
          if (el) onVideo(el);
        }}
      />
      <PlayerControls
        videoRef={videoRef as RefObject<HTMLVideoElement | null>}
        containerRef={containerRef}
        itemId="item-1"
        title="Un film"
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
      />
    </div>
  );
}

describe("PlayerControls — rafale de sauts", () => {
  it("garde les boutons, tait le chargement une demi-seconde, puis l'anneau ; la bulle additionne", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => null }));
    let video!: HTMLVideoElement;
    const { container } = render(<Harness onVideo={(v) => (video = v)} />);
    Object.defineProperty(video, "duration", { configurable: true, value: 3600 });
    let time = 100;
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => time, set: (v: number) => (time = v) });
    Object.defineProperty(video, "paused", { configurable: true, value: false });
    await act(async () => {});
    const nav = (name: string) => container.querySelector(`[data-player-nav="${name}"]`) as HTMLElement | null;

    // Trois +10 de suite ; le lecteur attend ses octets (`waiting`).
    for (let i = 0; i < 3; i++) await act(async () => void fireEvent.click(nav("skip-fwd")!));
    await act(async () => void fireEvent(video, new Event("waiting")));
    expect(time).toBe(130);
    expect(nav("skip-fwd")).not.toBeNull();
    expect(container.querySelector(".player-wait-wheel")).toBeNull();
    expect(container.querySelector(".player-wait-thread")).toBeNull();
    expect(container.querySelector("[data-player-skip-total]")?.textContent).toBe("+0:30");

    // La demi-seconde passée, toujours sans image : le fil et l'anneau, les boutons toujours là, plus de bulle.
    await act(async () => void vi.advanceTimersByTime(600));
    expect(container.querySelector(".player-wait-thread")).not.toBeNull();
    expect(container.querySelector(".player-wait-wheel")).toBeNull();
    expect(nav("playpause")!.querySelector(".player-resume-ring")).not.toBeNull();
    expect(nav("skip-fwd")).not.toBeNull();
    expect(container.querySelector("[data-player-skip-total]")).toBeNull();

    // L'image repart : la rafale est finie ; une attente ordinaire reprend la roue d'avant.
    await act(async () => void fireEvent(video, new Event("playing")));
    expect(nav("playpause")!.querySelector(".player-resume-ring")).toBeNull();
    await act(async () => void fireEvent(video, new Event("waiting")));
    expect(container.querySelector(".player-wait-wheel")).not.toBeNull();
  });

  it("l'heure de fin sous le temps restant, selon la vitesse ; rien dans la dernière minute", async () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 18, 22, 0, 0), toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => null }));
    let video!: HTMLVideoElement;
    const { container } = render(<Harness onVideo={(v) => (video = v)} />);
    Object.defineProperty(video, "duration", { configurable: true, value: 3600 });
    let time = 0;
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => time, set: (v: number) => (time = v) });
    await act(async () => void fireEvent(video, new Event("durationchange")));
    await act(async () => void fireEvent(video, new Event("timeupdate")));
    const ends = () => container.querySelector("[data-player-ends]")?.textContent ?? null;
    expect(ends()).toBe('player.endsAt:{"time":"23:00"}');
    Object.defineProperty(video, "playbackRate", { configurable: true, value: 2 });
    await act(async () => void fireEvent(video, new Event("ratechange")));
    expect(ends()).toBe('player.endsAt:{"time":"22:30"}');
    time = 3570;
    await act(async () => void fireEvent(video, new Event("timeupdate")));
    expect(ends()).toBeNull();
  });
});
