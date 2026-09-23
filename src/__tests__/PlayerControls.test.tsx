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

describe("PlayerControls — la barre de progression", () => {
  /** The bar only tracks a pointer once the film has a length to map it onto. */
  const withDuration = async (video: HTMLVideoElement, bar: HTMLElement) => {
    Object.defineProperty(video, "duration", { value: 3600, configurable: true });
    bar.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 20, right: 200, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
    await act(async () => void video.dispatchEvent(new Event("durationchange")));
  };

  it("s'épaissit sous le doigt et redevient fine dès qu'il part", async () => {
    // Keyed off the component's own state rather than :hover — WebKit keeps the hover state
    // after a tap until something else is touched, which left the bar thick long after the
    // finger had gone, until the whole overlay faded out.
    stubMediaFetches();
    let video: HTMLVideoElement | null = null;
    const { container } = render(<Harness onVideoRef={(v) => (video = v)} />);
    await act(async () => {});

    const bar = container.querySelector(".player-seek")!.parentElement!;
    await withDuration(video!, bar);
    expect(bar.hasAttribute("data-scrub")).toBe(false);

    await act(async () => void fireEvent.touchStart(bar, { touches: [{ clientX: 40 }] }));
    expect(bar.hasAttribute("data-scrub")).toBe(true);

    await act(async () => void fireEvent.touchEnd(container.querySelector(".player-seek")!));
    expect(bar.hasAttribute("data-scrub")).toBe(false);
  });

  it("saute là où le doigt s'est posé, pas là où la pastille était", async () => {
    // An input[type=range] on iOS does not jump to where it is touched: the thumb has to be
    // grabbed and dragged. While the thumb was always visible that was guessable; hidden at
    // rest, touching the bar showed the thumbnail — the container follows the finger — without
    // the input moving at all, so releasing changed nothing.
    stubMediaFetches();
    let video: HTMLVideoElement | null = null;
    const { container } = render(<Harness onVideoRef={(v) => (video = v)} />);
    await act(async () => {});
    const bar = container.querySelector(".player-seek")!.parentElement!;
    await withDuration(video!, bar);

    // A quarter of the way along a bar two hundred pixels wide, on an hour-long film.
    await act(async () => void fireEvent.touchStart(bar, { touches: [{ clientX: 50 }] }));
    await act(async () => void fireEvent.touchEnd(bar));

    expect(video!.currentTime).toBeCloseTo(900, 0);
  });

  it("fait suivre la barre au doigt, pas seulement la vignette", async () => {
    // A touch drag never reaches the input's own onChange — an input[type=range] on iOS only
    // tracks its thumb — so the filled portion, the thumb and the timecode stayed where playback
    // was while only the thumbnail moved. One navigated blind.
    stubMediaFetches();
    let video: HTMLVideoElement | null = null;
    const { container } = render(<Harness onVideoRef={(v) => (video = v)} />);
    await act(async () => {});
    const bar = container.querySelector(".player-seek")!.parentElement!;
    const input = container.querySelector(".player-seek") as HTMLInputElement;
    await withDuration(video!, bar);

    await act(async () => void fireEvent.touchStart(input, { touches: [{ clientX: 100 }] }));
    await act(async () => void fireEvent.touchStart(bar, { touches: [{ clientX: 100 }] }));
    // Half of a two-hundred-pixel bar on an hour-long film, before anything is committed.
    expect(Number(input.value)).toBeCloseTo(1800, 0);
    expect(video!.currentTime).toBe(0);

    await act(async () => void fireEvent.touchMove(bar, { touches: [{ clientX: 150 }] }));
    expect(Number(input.value)).toBeCloseTo(2700, 0);
  });

  it("à la souris, saute là où est le curseur, pas là où l'input l'a placé", async () => {
    // L'input natif ne compte pas la demi-pastille à chaque bout : sa valeur, pour un même
    // pixel, tombe avant ce que la vignette annonce — neuf secondes au début d'un épisode de
    // 45 min sur un écran de PC (« je vise 6:54, il me met à 6:48 », Chrome et Firefox).
    stubMediaFetches();
    let video: HTMLVideoElement | null = null;
    const { container } = render(<Harness onVideoRef={(v) => (video = v)} />);
    await act(async () => {});
    const bar = container.querySelector(".player-seek")!.parentElement!;
    const input = container.querySelector(".player-seek") as HTMLInputElement;
    await withDuration(video!, bar);

    await act(async () => void fireEvent.mouseDown(input, { clientX: 50 }));
    await act(async () => void fireEvent.mouseMove(bar, { clientX: 50 }));
    // Puis l'action par défaut du navigateur, qui passe après la propagation : avec une
    // pastille de 14 px, (50 − 7) / (200 − 14) de l'heure.
    await act(async () => void fireEvent.change(input, { target: { value: "832" } }));
    expect(Number(input.value)).toBeCloseTo(900, 0);
    await act(async () => void fireEvent.mouseUp(input, { clientX: 50 }));

    expect(video!.currentTime).toBeCloseTo(900, 0);
  });

  it("ne suit pas un curseur qui ne fait que passer", async () => {
    // Previewing what is under the pointer is one thing; moving the playhead under it would be
    // the bar chasing the mouse.
    stubMediaFetches();
    let video: HTMLVideoElement | null = null;
    const { container } = render(<Harness onVideoRef={(v) => (video = v)} />);
    await act(async () => {});
    const bar = container.querySelector(".player-seek")!.parentElement!;
    const input = container.querySelector(".player-seek") as HTMLInputElement;
    await withDuration(video!, bar);

    await act(async () => void fireEvent.mouseMove(bar, { clientX: 150 }));
    expect(Number(input.value)).toBe(0);
  });

  it("un toucher bref ne saute qu'une fois, malgré les événements souris que le navigateur rejoue", async () => {
    // Après un touchend, le navigateur envoie au même point mousemove, mousedown et mouseup
    // « de compatibilité ». Le conteneur validait au touchend, puis l'onMouseUp de l'input
    // validait une seconde fois : deux demandes de saut, currentTime écrit deux fois (le saut
    // recommençait) et une ligne « superseded » fantôme dans le journal du lecteur.
    stubMediaFetches();
    let video: HTMLVideoElement | null = null;
    const onSeekRequest = vi.fn();
    const { container } = render(<Harness onVideoRef={(v) => (video = v)} onSeekRequest={onSeekRequest} />);
    await act(async () => {});
    const bar = container.querySelector(".player-seek")!.parentElement!;
    const input = container.querySelector(".player-seek") as HTMLInputElement;
    await withDuration(video!, bar);

    await act(async () => void fireEvent.touchStart(input, { touches: [{ clientX: 50 }] }));
    await act(async () => void fireEvent.touchEnd(input));
    await act(async () => void fireEvent.mouseMove(input, { clientX: 50 }));
    await act(async () => void fireEvent.mouseDown(input, { clientX: 50 }));
    await act(async () => void fireEvent.mouseUp(input, { clientX: 50 }));

    expect(onSeekRequest).toHaveBeenCalledTimes(1);
    expect(onSeekRequest.mock.calls[0][0]).toBeCloseTo(900, 0);
    // Et la barre redevient fine : le mousemove rejoué ne rallume pas la vignette.
    expect(bar.hasAttribute("data-scrub")).toBe(false);
  });

  it("un vrai clic de souris saute toujours, une fois", async () => {
    stubMediaFetches();
    let video: HTMLVideoElement | null = null;
    const onSeekRequest = vi.fn();
    const { container } = render(<Harness onVideoRef={(v) => (video = v)} onSeekRequest={onSeekRequest} />);
    await act(async () => {});
    const bar = container.querySelector(".player-seek")!.parentElement!;
    const input = container.querySelector(".player-seek") as HTMLInputElement;
    await withDuration(video!, bar);

    await act(async () => void fireEvent.mouseMove(bar, { clientX: 100 }));
    await act(async () => void fireEvent.mouseDown(input, { clientX: 100 }));
    await act(async () => void fireEvent.mouseUp(input, { clientX: 100 }));

    expect(onSeekRequest).toHaveBeenCalledTimes(1);
    expect(video!.currentTime).toBeCloseTo(1800, 0);
  });

  it("ne valide rien quand le système reprend le toucher", async () => {
    // The finger was not released, it was taken away.
    stubMediaFetches();
    let video: HTMLVideoElement | null = null;
    const { container } = render(<Harness onVideoRef={(v) => (video = v)} />);
    await act(async () => {});
    const bar = container.querySelector(".player-seek")!.parentElement!;
    await withDuration(video!, bar);

    await act(async () => void fireEvent.touchStart(bar, { touches: [{ clientX: 50 }] }));
    await act(async () => void fireEvent.touchCancel(bar));
    expect(video!.currentTime).toBe(0);
  });

  it("redevient fine aussi quand le système reprend le toucher", async () => {
    // A touch the system takes back never reaches touchend.
    stubMediaFetches();
    let video: HTMLVideoElement | null = null;
    const { container } = render(<Harness onVideoRef={(v) => (video = v)} />);
    await act(async () => {});
    const bar = container.querySelector(".player-seek")!.parentElement!;
    await withDuration(video!, bar);

    await act(async () => void fireEvent.touchStart(bar, { touches: [{ clientX: 40 }] }));
    expect(bar.hasAttribute("data-scrub")).toBe(true);
    await act(async () => void fireEvent.touchCancel(bar));
    expect(bar.hasAttribute("data-scrub")).toBe(false);
  });
});

describe("PlayerControls — le volume", () => {
  const asIphone = () => {
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15",
      configurable: true,
    });
  };
  const asDesktop = () => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (X11; Linux x86_64)", configurable: true });
    Object.defineProperty(navigator, "platform", { value: "Linux x86_64", configurable: true });
  };

  it("retire le curseur là où la plateforme ne le laisse pas agir", async () => {
    // iOS *stores* the value written to video.volume and hands it back unchanged while ignoring
    // it for output, so trying it and reading it back answers yes every time — and the control
    // stayed on screen behaving as a mute switch with nothing in between.
    asIphone();
    stubMediaFetches();
    render(<Harness />);
    await act(async () => {});
    expect(screen.queryByLabelText("player.volume")).toBeNull();
    asDesktop();
  });

  it("le garde partout où il fonctionne", async () => {
    asDesktop();
    stubMediaFetches();
    render(<Harness />);
    await act(async () => {});
    expect(screen.queryByLabelText("player.volume")).not.toBeNull();
  });
});

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

describe("PlayerControls — la sortie de diffusion", () => {
  // Sans elle, un spectateur qui ouvre le sélecteur puis choisit de rester sur son téléphone n'a
  // rien diffusé du tout : l'état sans-fil n'est jamais passé à vrai, donc il ne repasse jamais à
  // faux, donc aucun événement ne se déclenche — et il reste sur l'autre lecteur jusqu'à la fin
  // du film. C'est le seul chemin de retour qui ne dépend de rien.
  async function openMenu(props: Record<string, unknown>) {
    stubMediaFetches();
    const { container } = render(<Harness {...props} />);
    await act(async () => {});
    const more = container.querySelector('[data-player-nav="more"]') ?? screen.getAllByRole("button").at(-1)!;
    await act(async () => void fireEvent.click(more));
    return container;
  }

  it("n'existe pas dans une lecture ordinaire", async () => {
    await openMenu({});
    expect(screen.queryByText("player.castReturn")).toBeNull();
    expect(screen.queryByText("player.castStop")).toBeNull();
  });

  it("propose de revenir quand rien ne diffuse", async () => {
    await openMenu({ onCastReturn: vi.fn(), castActive: false });
    expect(screen.getByText("player.castReturn")).toBeTruthy();
  });

  it("propose d'arrêter quand quelque chose diffuse", async () => {
    // Le mot change, le geste non : revenir au lecteur met fin à la diffusion de toute façon,
    // puisque l'élément qui l'alimentait disparaît.
    await openMenu({ onCastReturn: vi.fn(), castActive: true });
    expect(screen.getByText("player.castStop")).toBeTruthy();
    expect(screen.queryByText("player.castReturn")).toBeNull();
  });

  it("rend la main au premier appui", async () => {
    const onCastReturn = vi.fn();
    await openMenu({ onCastReturn, castActive: false });
    await act(async () => void fireEvent.click(screen.getByText("player.castReturn")));
    expect(onCastReturn).toHaveBeenCalledTimes(1);
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
    // Le compte à rebours ne court que pendant la lecture — voir le test suivant.
    act(() => video.dispatchEvent(new Event("play")));
    act(() => video.dispatchEvent(new Event("timeupdate")));
    expect(screen.getByText("Next Ep")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    expect(onAdvance).toHaveBeenCalled();
  });

  /**
   * Une pause pendant le générique suspend le compte à rebours.
   *
   * Il courait film arrêté : mettre en pause pour aller répondre à la porte, et l'épisode suivant
   * démarrait tout seul pendant qu'on n'était pas là (relevé le 23/09/2026).
   */
  it("ne passe pas à l'épisode suivant pendant une pause", async () => {
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
      vi.advanceTimersByTime(20_000);
    });
    expect(onAdvance).not.toHaveBeenCalled();
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

/**
 * L'incrustation est offerte par le navigateur, pas par cette app : elle sort la vidéo de la
 * page sans rien dire au conteneur, qui restait en plein écran — un écran entier vide dont on
 * ne sortait qu'avec Échap.
 */
describe("PlayerControls et l'incrustation", () => {
  it("quitte le plein écran quand la vidéo passe en incrustation", async () => {
    const exitFullscreen = vi.fn().mockResolvedValue(undefined);
    let video: HTMLVideoElement | null = null;
    render(<Harness onVideoRef={(el) => { video = el; }} />);

    Object.defineProperty(document, "fullscreenElement", { value: document.body, configurable: true });
    Object.defineProperty(document, "exitFullscreen", { value: exitFullscreen, configurable: true });

    await act(async () => {
      video!.dispatchEvent(new Event("enterpictureinpicture"));
    });
    expect(exitFullscreen).toHaveBeenCalled();
  });

  it("ne touche à rien quand il n'y avait pas de plein écran", async () => {
    const exitFullscreen = vi.fn().mockResolvedValue(undefined);
    let video: HTMLVideoElement | null = null;
    render(<Harness onVideoRef={(el) => { video = el; }} />);

    Object.defineProperty(document, "fullscreenElement", { value: null, configurable: true });
    Object.defineProperty(document, "exitFullscreen", { value: exitFullscreen, configurable: true });

    await act(async () => {
      video!.dispatchEvent(new Event("enterpictureinpicture"));
    });
    expect(exitFullscreen).not.toHaveBeenCalled();
  });
});

/**
 * Le clavier du lecteur supposait qu'on soit d'abord entré dedans. Le lecteur stable amenait ce
 * focus lui-même à l'ouverture ; le lecteur natif, devenu celui de tout le monde, ne l'a jamais
 * fait — d'où l'impression, juste, qu'il n'avait plus de clavier.
 */
describe("PlayerControls au clavier, sans focus dans le lecteur", () => {
  function press(code: string) {
    fireEvent.keyDown(window, { code });
  }

  it("met en pause et relance à la barre d'espace", async () => {
    let video: HTMLVideoElement | null = null;
    render(<Harness onVideoRef={(el) => { video = el; }} />);
    const play = vi.spyOn(video!, "play").mockResolvedValue(undefined);
    Object.defineProperty(video!, "paused", { value: true, configurable: true });

    await act(async () => { press("Space"); });
    expect(play).toHaveBeenCalled();
  });

  it("saute de dix secondes aux flèches gauche et droite", async () => {
    stubMediaFetches();
    let video: HTMLVideoElement | null = null;
    render(<Harness onVideoRef={(el) => { video = el; }} />);
    // La durée est de l'état, alimenté par l'événement : sans lui, le saut se borne à la position
    // courante et ne bouge pas. Et `currentTime` n'est pas assignable sur un élément jsdom tant
    // qu'on ne l'a pas redéfini.
    Object.defineProperty(video!, "duration", { value: 600, configurable: true });
    Object.defineProperty(video!, "currentTime", { value: 100, writable: true, configurable: true });
    await act(async () => { video!.dispatchEvent(new Event("durationchange")); });

    await act(async () => { press("ArrowRight"); });
    expect(video!.currentTime).toBeCloseTo(110, 1);

    await act(async () => { press("ArrowLeft"); });
    expect(video!.currentTime).toBeCloseTo(100, 1);
  });

  it("règle le son aux flèches haut et bas", async () => {
    let video: HTMLVideoElement | null = null;
    render(<Harness onVideoRef={(el) => { video = el; }} />);
    video!.volume = 0.5;

    await act(async () => { press("ArrowUp"); });
    expect(video!.volume).toBeCloseTo(0.6, 2);

    await act(async () => { press("ArrowDown"); press("ArrowDown"); });
    expect(video!.volume).toBeCloseTo(0.4, 2);
  });

  it("ne descend ni ne monte au-delà des bornes", async () => {
    let video: HTMLVideoElement | null = null;
    render(<Harness onVideoRef={(el) => { video = el; }} />);
    video!.volume = 0.95;

    await act(async () => { press("ArrowUp"); press("ArrowUp"); });
    expect(video!.volume).toBe(1);
  });

  it("coupe le son avec M", async () => {
    let video: HTMLVideoElement | null = null;
    render(<Harness onVideoRef={(el) => { video = el; }} />);

    await act(async () => { press("KeyM"); });
    expect(video!.muted).toBe(true);
  });
});

describe("PlayerControls — une touche pendant le film", () => {
  it("montre les contrôles puis les retire, comme un geste de la souris", async () => {
    // Relu le 22/09/2026 : le raccourci gardait le `playing` du montage — en pause —, si bien
    // qu'une touche pendant le film affichait les contrôles pour de bon.
    stubMediaFetches();
    vi.useFakeTimers();
    let video!: HTMLVideoElement;
    const { container } = render(<Harness onVideoRef={(v) => (video = v)} />);
    await act(async () => {});
    Object.defineProperty(video, "paused", { value: false, configurable: true });
    Object.defineProperty(video, "duration", { value: 3600, configurable: true });
    act(() => void video.dispatchEvent(new Event("play")));
    await act(async () => void vi.advanceTimersByTime(4000));
    const overlay = () => container.querySelector(".absolute.inset-0.z-10 > div") as HTMLElement;
    const shown = () => !overlay().className.includes("opacity-0");
    expect(shown()).toBe(false);

    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight" })));
    expect(shown()).toBe(true);
    await act(async () => void vi.advanceTimersByTime(4000));
    expect(shown()).toBe(false);
  });
});

describe("PlayerControls — suspendues pendant une reconstruction", () => {
  it("ne répondent plus au clavier", async () => {
    // Une barre d'espace pendant la reconstruction relançait un film qui devait rester en pause.
    stubMediaFetches();
    let video!: HTMLVideoElement;
    const play = vi.fn();
    render(
      <Harness
        suspended
        onVideoRef={(v) => {
          video = v;
          video.play = play;
        }}
      />
    );
    await act(async () => {});
    Object.defineProperty(video, "paused", { value: true, configurable: true });
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space" })));
    expect(play).not.toHaveBeenCalled();
  });
});


/**
 * Relu le 23/09/2026 : ce que le clavier ne doit pas prendre.
 *
 * Ctrl+F cherche dans la page et Cmd+← revient en arrière : le lecteur sautait de dix secondes en
 * plus. Et un champ où l'on écrit garde ses touches — une espace y mettait le film en pause.
 */
describe("PlayerControls — clavier, relu le 23/09/2026", () => {
  async function mounted() {
    stubMediaFetches();
    let video!: HTMLVideoElement;
    const play = vi.fn();
    render(
      <Harness
        onVideoRef={(v) => {
          video = v;
          video.play = play;
        }}
      />
    );
    await act(async () => {});
    Object.defineProperty(video, "duration", { value: 3600, configurable: true });
    Object.defineProperty(video, "paused", { value: true, configurable: true });
    video.currentTime = 100;
    return { video, play };
  }

  it("laisse passer les raccourcis du navigateur et du système", async () => {
    const { video } = await mounted();
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight", ...modifier })));
    }
    expect(video.currentTime).toBe(100);
    // La même touche, seule, reste un saut.
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight" })));
    expect(video.currentTime).toBe(110);
  });

  it("laisse ses touches à un champ de saisie", async () => {
    const { play } = await mounted();
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);
    input.focus();
    act(() => void input.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true })));
    expect(play).not.toHaveBeenCalled();
    input.remove();
  });
});

describe("PlayerControls — relu le 23/09/2026", () => {
  /**
   * Le décalage des sous-titres, quand l'hôte les dessine lui-même.
   *
   * Le lecteur natif écrit ses lignes sous l'image, sans passer par les pistes du `<video>` :
   * les boutons ±0,5 s déplaçaient des lignes que personne n'affichait.
   */
  it("confie le décalage des sous-titres à l'hôte qui les dessine", async () => {
    stubMediaFetches();
    const onShift = vi.fn();
    render(
      <Harness
        subtitleTracks={[{ id: 3, label: "Français" }]}
        currentSubtitleId={3}
        subtitleOffset={{ seconds: 1.5, onShift }}
      />
    );
    await act(async () => {});
    fireEvent.click(document.querySelector('[data-player-nav="more"]')!);
    // Le chiffre affiché est celui de l'hôte, pas un compte tenu à part.
    expect(screen.getByText((_, el) => el?.tagName === "SPAN" && el.textContent === "+1.5s")).toBeInTheDocument();
    fireEvent.click(screen.getByText("+0.5s"));
    expect(onShift).toHaveBeenCalledWith(0.5);
  });

  /** « Chapitre 3 » s'écrivait côté serveur, en français, quelle que soit la langue du compte. */
  it("nomme un chapitre sans nom dans la langue de l'app", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/chapters")
          ? { ok: true, json: async () => [{ start: 0, name: null }, { start: 60, name: "La fin" }] }
          : { ok: false, json: async () => null }
      )
    );
    render(<Harness />);
    await act(async () => {});
    fireEvent.click(document.querySelector('[data-player-nav="more"]')!);
    fireEvent.click(await screen.findByText("player.chapters"));
    expect(screen.getByText('player.chapterN:{"n":1}')).toBeInTheDocument();
    expect(screen.getByText("La fin")).toBeInTheDocument();
  });

  /**
   * Des commandes effacées ne se touchent pas.
   *
   * Invisibles, elles restaient sous le doigt : un toucher pour faire réapparaître les commandes
   * pressait le bouton caché dessous — fermer le film, en haut à droite (relevé le 23/09/2026).
   */
  it("ne laisse pas presser un bouton effacé", async () => {
    stubMediaFetches();
    vi.useFakeTimers();
    let video!: HTMLVideoElement;
    const { container } = render(<Harness onVideoRef={(v) => (video = v)} />);
    await act(async () => {});
    Object.defineProperty(video, "paused", { value: false, configurable: true });
    act(() => void video.dispatchEvent(new Event("play")));
    await act(async () => void vi.advanceTimersByTime(4000));
    const close = container.querySelector('[data-player-nav="close"]')!;
    // Le plus proche des deux décide : un groupe `pointer-events-auto` sous un calque
    // `pointer-events-none` rend ses boutons de nouveau touchables.
    const decides = close.closest(".pointer-events-none, .pointer-events-auto");
    expect(decides?.classList.contains("pointer-events-none")).toBe(true);
  });
});

describe("PlayerControls — relu le 23/09/2026, suite", () => {
  /**
   * Sans générique connu, la carte « Épisode suivant » arrive à la dernière seconde.
   *
   * Elle n'apparaissait qu'au début du générique — et Jellyfin 12 n'en donnait plus aucun : le
   * lecteur restait figé sur la dernière image, sans rien proposer.
   */
  it("propose l'épisode suivant à la fin quand aucun générique n'est connu", async () => {
    stubMediaFetches();
    let video!: HTMLVideoElement;
    render(
      <Harness nextEpisode={{ itemId: "next-1", title: "Next Ep" }} onVideoRef={(v) => (video = v)} />
    );
    await act(async () => {});
    Object.defineProperty(video, "duration", { value: 1500, configurable: true });
    act(() => void video.dispatchEvent(new Event("durationchange")));
    Object.defineProperty(video, "currentTime", { value: 1000, configurable: true });
    act(() => void video.dispatchEvent(new Event("timeupdate")));
    expect(screen.queryByText("Next Ep")).toBeNull();

    Object.defineProperty(video, "currentTime", { value: 1499.5, configurable: true });
    act(() => void video.dispatchEvent(new Event("timeupdate")));
    expect(screen.getByText("Next Ep")).toBeInTheDocument();
  });

  /**
   * Un menu ouvert garde les commandes à l'écran.
   *
   * Elles s'effaçaient au bout de trois secondes avec le menu dedans, pendant qu'on lisait la
   * liste des pistes.
   */
  it("ne retire pas les commandes pendant qu'un menu est ouvert", async () => {
    stubMediaFetches();
    vi.useFakeTimers();
    let video!: HTMLVideoElement;
    const { container } = render(<Harness onVideoRef={(v) => (video = v)} />);
    await act(async () => {});
    Object.defineProperty(video, "paused", { value: false, configurable: true });
    act(() => void video.dispatchEvent(new Event("play")));
    fireEvent.click(container.querySelector('[data-player-nav="more"]')!);
    await act(async () => void vi.advanceTimersByTime(10_000));
    expect(screen.getByText("player.playbackInfo")).toBeInTheDocument();
    const overlay = container.querySelector(".absolute.inset-0.z-10 > div") as HTMLElement;
    expect(overlay.className.includes("opacity-0")).toBe(false);
  });
});

/**
 * Sous le doigt, la barre suit le doigt et rien d'autre.
 *
 * Sur iOS, un doigt posé sur la pastille fait aussi glisser l'input natif, en relatif. Ses
 * valeurs se mêlaient à celles du doigt : sauts, saccades, tremblement (signalé le 23/09/2026).
 */
describe("PlayerControls — glisser au doigt sur la barre", () => {
  async function mountedBar() {
    stubMediaFetches();
    let video!: HTMLVideoElement;
    const { container } = render(<Harness onVideoRef={(v) => (video = v)} />);
    await act(async () => {});
    Object.defineProperty(video, "duration", { value: 3600, configurable: true });
    await act(async () => void video.dispatchEvent(new Event("durationchange")));
    const input = container.querySelector('input[data-player-nav="seek"]') as HTMLInputElement;
    const bar = input.parentElement as HTMLElement;
    bar.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 20, right: 200, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
    return { input };
  }

  it("ignore la valeur que l'input natif se donne pendant le glisser", async () => {
    const { input } = await mountedBar();
    fireEvent.touchStart(input, { touches: [{ clientX: 100 }] });
    fireEvent.touchMove(input, { touches: [{ clientX: 102 }] });
    // L'input natif, parti de sa pastille, annonce autre chose que le doigt.
    fireEvent.change(input, { target: { value: "300" } });
    expect(Number(input.value)).toBeCloseTo(1836, 0);
  });

  it("ne bouge pas pour un tremblement de moins d'un pixel", async () => {
    const { input } = await mountedBar();
    fireEvent.touchStart(input, { touches: [{ clientX: 100 }] });
    fireEvent.touchMove(input, { touches: [{ clientX: 100.4 }] });
    expect(Number(input.value)).toBeCloseTo(1800, 0);
    fireEvent.touchMove(input, { touches: [{ clientX: 101.5 }] });
    expect(Number(input.value)).toBeCloseTo(1827, 0);
  });
});

// L'ajustement aux bandes noires du fichier (24/09/2026) : un interrupteur, et seulement quand il y
// a un agrandissement à défaire.
describe("ajuster à l'écran", () => {
  async function openMore(props: Record<string, unknown>) {
    stubMediaFetches();
    const { container } = render(<Harness {...props} />);
    await act(async () => {});
    await act(async () => void fireEvent.click(container.querySelector('[data-player-nav="more"]')!));
  }

  it("n'apparaît pas sans agrandissement", async () => {
    await openMore({});
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("dit son état et le bascule sans fermer le menu", async () => {
    const onChange = vi.fn();
    await openMore({ frameFit: { on: true, onChange } });
    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.textContent).toContain("player.frameFit");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(false);
    expect(screen.getByRole("switch")).toBeTruthy();
  });
});

