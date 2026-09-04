// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, type RefObject } from "react";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

import { PlayerControls } from "@/components/PlayerControls";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

// PlayerControls does its own chapters/trickplay fetches on mount — stubbed to a harmless 404
// (`.then((r) => r.ok ? ... : [])` handles it) so every test doesn't need to know about them.
function stubMediaFetches() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => null }));
}

describe("PlayerControls — un seul matériau", () => {
  it("habille les boutons et les panneaux de la même surface", async () => {
    // Three surface systems used to sit on the same screen — a white-translucent cluster,
    // black-translucent transport buttons, an opaque slate menu — across four corner radii.
    // Nothing wrong on its own; together it is what makes a player look home-made.
    stubMediaFetches();
    const { container } = render(<Harness subtitleTracks={[{ id: 1, label: "Français" }]} currentSubtitleId={1} />);
    await act(async () => {});

    const buttons = screen
      .getAllByRole("button")
      .filter((b) => ["captions", "more", "minimize", "close", "playpause", "skip-back", "skip-fwd"].includes(b.getAttribute("data-player-nav") ?? ""));
    expect(buttons.length).toBeGreaterThanOrEqual(6);
    for (const button of buttons) {
      expect(button.className).toContain("player-glass");
      expect(button.className).toContain("rounded-full");
    }

    await act(async () => void fireEvent.click(screen.getAllByRole("button").find((b) => b.getAttribute("data-player-nav") === "more")!));
    expect(container.querySelector(".player-panel")).not.toBeNull();
  });
});

describe("PlayerControls — le menu", () => {
  it("ne défile jamais horizontalement, quelle que soit la longueur des libellés", async () => {
    // The subtitle offset row asks for a label and three controls side by side; too narrow a box
    // overflowed, and a box that scrolls in one direction scrolls in both — which is how a
    // horizontal bar turned up under a menu nobody had asked to scroll.
    stubMediaFetches();
    const { container } = render(
      <Harness subtitleTracks={[{ id: 1, label: "Français" }]} currentSubtitleId={1} />
    );
    await act(async () => {});

    const more = container.querySelector('[data-player-nav="more"]') ?? screen.getAllByRole("button").at(-1)!;
    await act(async () => void fireEvent.click(more));

    const menu = container.querySelector(".max-h-\\[60vh\\]");
    expect(menu).not.toBeNull();
    expect(menu!.className).toContain("overflow-x-hidden");
  });
});

describe("PlayerControls — l'attente d'un saut", () => {
  /** The spinner and the centre buttons are exclusive: one replaces the other. */
  /** The thread that runs across the top while the player is working. */
  const spinning = (container: HTMLElement) => !!container.querySelector(".player-loading-line");

  it("montre que ça travaille quand un saut prend du temps", async () => {
    // Without this the pause button simply stayed where it was while the player went and
    // fetched the position — which on a dense file is seconds, and reads as a freeze rather
    // than as work in progress.
    vi.useFakeTimers();
    stubMediaFetches();
    let element: HTMLVideoElement | null = null;
    const { container } = render(<Harness onVideoRef={(v) => (element = v)} />);
    await act(async () => {});
    expect(spinning(container)).toBe(false);

    Object.defineProperty(element!, "paused", { value: false, configurable: true });
    Object.defineProperty(element!, "seeking", { value: true, configurable: true });
    await act(async () => void element!.dispatchEvent(new Event("seeking")));
    await act(async () => void vi.advanceTimersByTime(200));
    expect(spinning(container)).toBe(true);

    Object.defineProperty(element!, "seeking", { value: false, configurable: true });
    await act(async () => void element!.dispatchEvent(new Event("seeked")));
    expect(spinning(container)).toBe(false);
    vi.useRealTimers();
  });

  it("ne fait pas passer une mise en pause pour un chargement", async () => {
    // Pausing *is* a seek here: the position is re-stated at the button to flush the sound iOS
    // still holds queued. So pressing pause announced itself as work — the three centre buttons
    // vanished and the loading thread ran, as though stopping the film needed fetching.
    vi.useFakeTimers();
    stubMediaFetches();
    let element: HTMLVideoElement | null = null;
    const { container } = render(<Harness onVideoRef={(v) => (element = v)} />);
    await act(async () => {});

    Object.defineProperty(element!, "paused", { value: true, configurable: true });
    Object.defineProperty(element!, "seeking", { value: true, configurable: true });
    await act(async () => void element!.dispatchEvent(new Event("seeking")));
    await act(async () => void vi.advanceTimersByTime(500));

    expect(spinning(container)).toBe(false);
    vi.useRealTimers();
  });

  it("range ce qu'il montrait si la pause arrive pendant le saut", async () => {
    vi.useFakeTimers();
    stubMediaFetches();
    let element: HTMLVideoElement | null = null;
    const { container } = render(<Harness onVideoRef={(v) => (element = v)} />);
    await act(async () => {});

    Object.defineProperty(element!, "paused", { value: false, configurable: true });
    Object.defineProperty(element!, "seeking", { value: true, configurable: true });
    await act(async () => void element!.dispatchEvent(new Event("seeking")));
    await act(async () => void vi.advanceTimersByTime(200));
    expect(spinning(container)).toBe(true);

    Object.defineProperty(element!, "paused", { value: true, configurable: true });
    await act(async () => void element!.dispatchEvent(new Event("pause")));
    expect(spinning(container)).toBe(false);
    vi.useRealTimers();
  });

  it("ne clignote pas pour un saut qui atterrit tout de suite", async () => {
    // Most seeks land in media the player already holds and finish within a frame. A spinner
    // that appears and goes before it can be seen is noise.
    vi.useFakeTimers();
    stubMediaFetches();
    let element: HTMLVideoElement | null = null;
    const { container } = render(<Harness onVideoRef={(v) => (element = v)} />);
    await act(async () => {});

    Object.defineProperty(element!, "seeking", { value: true, configurable: true });
    await act(async () => void element!.dispatchEvent(new Event("seeking")));
    Object.defineProperty(element!, "seeking", { value: false, configurable: true });
    await act(async () => void element!.dispatchEvent(new Event("seeked")));

    await act(async () => void vi.advanceTimersByTime(500));
    expect(spinning(container)).toBe(false);
    vi.useRealTimers();
  });
});

describe("PlayerControls", () => {
  it("renders nothing while hidden", async () => {
    stubMediaFetches();
    const { container } = render(<Harness hidden />);
    // Only the <video> (rendered by the harness, not PlayerControls itself) should remain.
    expect(container.querySelectorAll("video")).toHaveLength(1);
    expect(container.querySelector(".absolute.inset-0.z-10")).toBeNull();
    // Let the component's own mount-time chapters/trickplay fetches settle before the test ends,
    // so their state updates land inside act() instead of racing the next test's render.
    await act(async () => {});
  });

  it("play/pause button calls video.play()/pause() and reflects state from play/pause events", async () => {
    stubMediaFetches();
    let video!: HTMLVideoElement;
    const play = vi.fn();
    const pause = vi.fn();
    const user = userEvent.setup();
    render(
      <Harness
        onVideoRef={(v) => {
          video = v;
          video.play = play;
          video.pause = pause;
        }}
      />
    );

    // Starts paused -> shows the Play icon as the center button (no accessible name on the
    // icon-only button, so target it by its position among the three center buttons).
    // Targeted by their data attribute rather than by their styling — which is what broke this
    // when the three surface systems on screen were unified into one.
    const centerButtons = screen
      .getAllByRole("button")
      .filter((b) => ["skip-back", "playpause", "skip-fwd"].includes(b.getAttribute("data-player-nav") ?? ""));
    expect(centerButtons).toHaveLength(3);
    const [, playPause] = centerButtons;

    Object.defineProperty(video, "paused", { value: true, configurable: true });
    await user.click(playPause);
    expect(play).toHaveBeenCalled();

    // Simulate the video actually starting playback.
    Object.defineProperty(video, "paused", { value: false, configurable: true });
    act(() => video.dispatchEvent(new Event("play")));
    await waitFor(() => expect(screen.getByTitle("player.rewind10")).toBeInTheDocument()); // sanity: still rendered

    await user.click(playPause);
    expect(pause).toHaveBeenCalled();
  });

  it("skip buttons move currentTime by ±10s, clamped to [0, duration]", async () => {
    stubMediaFetches();
    let video!: HTMLVideoElement;
    const user = userEvent.setup();
    render(<Harness onVideoRef={(v) => { video = v; }} />);

    Object.defineProperty(video, "duration", { value: 100, configurable: true });
    Object.defineProperty(video, "currentTime", { value: 5, writable: true, configurable: true });
    act(() => video.dispatchEvent(new Event("durationchange")));

    await user.click(screen.getByTitle("player.rewind10"));
    // 5 - 10 clamped to 0
    expect(video.currentTime).toBe(0);

    video.currentTime = 95;
    await user.click(screen.getByTitle("player.forward10"));
    // 95 + 10 clamped to duration (100)
    expect(video.currentTime).toBe(100);
  });

  it("shows the skip-intro button only while currentTime is within the intro window", async () => {
    stubMediaFetches();
    let video!: HTMLVideoElement;
    render(
      <Harness
        introSkip={{ start: 10, end: 30 }}
        onVideoRef={(v) => { video = v; }}
      />
    );

    expect(screen.queryByText("player.skipIntro")).not.toBeInTheDocument();

    Object.defineProperty(video, "currentTime", { value: 15, configurable: true });
    act(() => video.dispatchEvent(new Event("timeupdate")));
    expect(await screen.findByText("player.skipIntro")).toBeInTheDocument();

    Object.defineProperty(video, "currentTime", { value: 35, configurable: true });
    act(() => video.dispatchEvent(new Event("timeupdate")));
    await waitFor(() => expect(screen.queryByText("player.skipIntro")).not.toBeInTheDocument());
  });

  it("clicking skip-intro seeks the video to the intro's end", async () => {
    stubMediaFetches();
    let video!: HTMLVideoElement;
    const user = userEvent.setup();
    render(
      <Harness
        introSkip={{ start: 10, end: 30 }}
        onVideoRef={(v) => { video = v; }}
      />
    );

    Object.defineProperty(video, "currentTime", { value: 15, writable: true, configurable: true });
    act(() => video.dispatchEvent(new Event("timeupdate")));
    await user.click(await screen.findByText("player.skipIntro"));

    expect(video.currentTime).toBe(30);
  });

  it("auto-advances to the next episode once the countdown reaches zero", async () => {
    stubMediaFetches();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let video!: HTMLVideoElement;
    const onAdvance = vi.fn();
    render(
      <Harness
        creditsStart={50}
        nextEpisode={{ itemId: "next-1", title: "Next Ep" }}
        onAdvance={onAdvance}
        onVideoRef={(v) => { video = v; }}
      />
    );

    Object.defineProperty(video, "currentTime", { value: 55, configurable: true });
    act(() => video.dispatchEvent(new Event("timeupdate")));
    expect(screen.getByText("Next Ep")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    expect(onAdvance).toHaveBeenCalled();
  });

  it("dismissing the next-up prompt hides it without calling onAdvance", async () => {
    stubMediaFetches();
    let video!: HTMLVideoElement;
    const onAdvance = vi.fn();
    const user = userEvent.setup();
    render(
      <Harness
        creditsStart={50}
        nextEpisode={{ itemId: "next-1", title: "Next Ep" }}
        onAdvance={onAdvance}
        onVideoRef={(v) => { video = v; }}
      />
    );

    Object.defineProperty(video, "currentTime", { value: 55, configurable: true });
    act(() => video.dispatchEvent(new Event("timeupdate")));
    const dismiss = screen.getByText("Next Ep").closest("div")!.querySelector("button:last-child")!;
    await user.click(dismiss);

    expect(screen.queryByText("Next Ep")).not.toBeInTheDocument();
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it("mute button toggles video.muted", async () => {
    stubMediaFetches();
    let video!: HTMLVideoElement;
    const user = userEvent.setup();
    render(<Harness onVideoRef={(v) => { video = v; }} />);

    Object.defineProperty(video, "muted", { value: false, writable: true, configurable: true });
    const muteButtons = screen.getAllByRole("button");
    const muteButton = muteButtons.find((b) => b.querySelector("svg.lucide-volume2"));
    expect(muteButton).toBeTruthy();
    await user.click(muteButton!);

    expect(video.muted).toBe(true);
  });

  it("close and minimize buttons call their respective callbacks", async () => {
    stubMediaFetches();
    const onClose = vi.fn();
    const onMinimize = vi.fn();
    const user = userEvent.setup();
    render(<Harness onClose={onClose} onMinimize={onMinimize} />);

    await user.click(screen.getByTitle("player.minimize"));
    expect(onMinimize).toHaveBeenCalled();

    const closeButton = screen.getAllByRole("button").find((b) => b.querySelector("svg.lucide-x") && !b.title);
    await user.click(closeButton!);
    expect(onClose).toHaveBeenCalled();
  });
});
