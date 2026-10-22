// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import { useRef, type RefObject } from "react";

/**
 * Deux mécaniques de `PlayerControls` que le découpage prévu (audit du lecteur, 22/10/2026, étape 3 :
 * `useAutoHide`, `PlayerSeekBar`) déplacerait d'un bloc, et dont les tests existants ne tenaient que
 * des morceaux :
 * - la disparition des commandes : trois secondes en lecture, jamais en pause, relancée par la
 *   souris mais pas par le doigt, dix secondes après un geste dans une rangée, suspendue par un menu,
 *   par la barre sous le pointeur et pendant une reprise, immédiate quand la souris quitte la fenêtre ;
 * - le glissement sur la barre, à la souris et au doigt : la vignette (heure, chapitre, planche
 *   d'aperçu au bon endroit) pendant le geste, rien de validé avant le relâchement, un seul saut à la fin.
 * On lit l'état des commandes par `data-chrome`, et la vignette par ce qu'elle affiche.
 */

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
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
  const { onVideoRef, ...rest } = props;
  return (
    <div ref={containerRef}>
      <video
        ref={(el) => {
          videoRef.current = el;
          if (el && onVideoRef) onVideoRef(el);
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
        {...rest}
      />
    </div>
  );
}

/** 10 × 10 vignettes de 320 × 180 toutes les 10 s : une planche couvre 1 000 s. */
const TRICKPLAY = { width: 320, height: 180, tileWidth: 10, tileHeight: 10, thumbnailCount: 360, intervalMs: 10_000 };
function stubFetches({ trickplay = false, chapters = false } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (trickplay && String(url).includes("/trickplay/info")) return { ok: true, json: async () => TRICKPLAY };
      if (chapters && String(url).startsWith("/api/jellyfin/chapters")) {
        return { ok: true, json: async () => [{ start: 0, name: "Ouverture" }, { start: 1200, name: "La traque" }] };
      }
      return { ok: false, json: async () => null };
    })
  );
}

async function mount(props: Partial<React.ComponentProps<typeof PlayerControls>> = {}) {
  let video!: HTMLVideoElement;
  const view = render(<Harness {...props} onVideoRef={(v) => (video = v)} />);
  await act(async () => {});
  const root = view.container.querySelector(".player-liquid") as HTMLElement;
  const shown = () => view.container.querySelector("[data-chrome]")!.getAttribute("data-chrome") === "shown";
  return { ...view, video: () => video, root, shown };
}

const advance = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));
async function startPlaying(video: HTMLVideoElement) {
  Object.defineProperty(video, "paused", { value: false, configurable: true });
  await act(async () => void video.dispatchEvent(new Event("play")));
}
async function pause(video: HTMLVideoElement) {
  Object.defineProperty(video, "paused", { value: true, configurable: true });
  await act(async () => void video.dispatchEvent(new Event("pause")));
}

describe("PlayerControls — la disparition des commandes", () => {
  it("en pause, elles restent ; en lecture, elles partent au bout de trois secondes", async () => {
    stubFetches();
    vi.useFakeTimers();
    const { video, shown } = await mount();
    await advance(60_000);
    expect(shown()).toBe(true);

    await startPlaying(video());
    await advance(2_900);
    expect(shown()).toBe(true);
    await advance(200);
    expect(shown()).toBe(false);
  });

  it("une mise en pause les rappelle, sans minuteur ; la reprise relance les trois secondes", async () => {
    stubFetches();
    vi.useFakeTimers();
    const { video, shown } = await mount();
    await startPlaying(video());
    await advance(3_100);
    expect(shown()).toBe(false);
    await pause(video());
    expect(shown()).toBe(true);
    await advance(60_000);
    expect(shown()).toBe(true);
    await startPlaying(video());
    await advance(3_100);
    expect(shown()).toBe(false);
  });

  it("la souris qui bouge les rappelle et relance le décompte ; un doigt qui glisse ne les rappelle pas", async () => {
    stubFetches();
    vi.useFakeTimers();
    const { video, root, shown } = await mount();
    await startPlaying(video());
    await advance(2_000);
    fireEvent.pointerMove(root, { pointerType: "mouse" });
    await advance(2_500);
    expect(shown()).toBe(true);
    await advance(600);
    expect(shown()).toBe(false);

    // Un doigt : le `pointermove` que le navigateur envoie avant le `click` ne doit rien montrer.
    fireEvent.pointerMove(root, { pointerType: "touch" });
    expect(shown()).toBe(false);
    fireEvent.pointerMove(root, { pointerType: "mouse" });
    expect(shown()).toBe(true);
  });

  it("un geste dans une rangée de commandes les garde dix secondes", async () => {
    stubFetches();
    vi.useFakeTimers();
    const { video, container, shown } = await mount();
    await startPlaying(video());
    await act(async () => void fireEvent.click(container.querySelector('[aria-label="player.minimize"]')!));
    await advance(9_800);
    expect(shown()).toBe(true);
    await advance(400);
    expect(shown()).toBe(false);
  });

  it("un menu ouvert les retient ; refermé, le décompte ordinaire repart", async () => {
    stubFetches();
    vi.useFakeTimers();
    const { video, container, shown } = await mount();
    await startPlaying(video());
    const more = container.querySelector('[data-player-nav="more"]')!;
    await act(async () => void fireEvent.click(more));
    await advance(60_000);
    expect(shown()).toBe(true);
    expect(container.querySelector(".player-menu")).not.toBeNull();

    await act(async () => void fireEvent.click(more));
    expect(container.querySelector(".player-menu")).toBeNull();
    await advance(2_900);
    expect(shown()).toBe(true);
    await advance(200);
    expect(shown()).toBe(false);
  });

  it("la souris qui quitte la fenêtre les cache tout de suite en lecture — jamais en pause, ni menu ouvert", async () => {
    stubFetches();
    vi.useFakeTimers();
    const { video, container, shown } = await mount();
    const leave = () => act(() => void window.dispatchEvent(new PointerEvent("pointerout", { pointerType: "mouse", relatedTarget: null })));

    await leave();
    expect(shown()).toBe(true);

    await startPlaying(video());
    const more = container.querySelector('[data-player-nav="more"]')!;
    await act(async () => void fireEvent.click(more));
    await leave();
    expect(shown()).toBe(true);
    await act(async () => void fireEvent.click(more));

    await leave();
    expect(shown()).toBe(false);
  });

  it("pendant une reprise, le minuteur attend la première image", async () => {
    stubFetches();
    vi.useFakeTimers();
    let video!: HTMLVideoElement;
    const { rerender, container } = render(<Harness resuming onVideoRef={(v) => (video = v)} />);
    await act(async () => {});
    const shown = () => container.querySelector("[data-chrome]")!.getAttribute("data-chrome") === "shown";
    await startPlaying(video);
    await advance(10_000);
    expect(shown()).toBe(true);

    rerender(<Harness resuming={false} onVideoRef={(v) => (video = v)} />);
    // Le prochain tic du minuteur (toutes les trois secondes) les retire.
    await advance(3_100);
    expect(shown()).toBe(false);
  });
});

describe("PlayerControls — glisser sur la barre", () => {
  async function bar(options: { trickplay?: boolean; chapters?: boolean } = {}) {
    stubFetches(options);
    const onSeekRequest = vi.fn();
    const mounted = await mount({ onSeekRequest });
    // Les aperçus et les chapitres arrivent par le réseau.
    for (let i = 0; i < 5; i++) await act(async () => {});
    const video = mounted.video();
    Object.defineProperty(video, "duration", { value: 3600, configurable: true });
    await act(async () => void video.dispatchEvent(new Event("durationchange")));
    const input = mounted.container.querySelector('input[data-player-nav="seek"]') as HTMLInputElement;
    const seekBar = input.parentElement as HTMLElement;
    seekBar.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 20, right: 200, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
    /** La vignette : son heure, son chapitre, sa planche — `null` quand elle n'est pas là. */
    const preview = () => {
      if (!seekBar.hasAttribute("data-scrub")) return null;
      const lines = [...seekBar.querySelectorAll("p")].map((p) => p.textContent);
      const tile = [...seekBar.querySelectorAll<HTMLElement>("div")].find((d) => d.style.backgroundImage.includes("/trickplay/tile"));
      return {
        time: lines.at(-1),
        chapter: lines.length > 1 ? lines[0] : null,
        tile: tile ? { image: tile.style.backgroundImage, position: tile.style.backgroundPosition } : null,
      };
    };
    const elapsed = () => mounted.container.querySelector("[data-player-elapsed]")!.textContent;
    return { ...mounted, video, input, seekBar, preview, elapsed, onSeekRequest };
  }

  it("à la souris : la vignette et l'heure suivent le curseur, rien n'est validé avant le relâchement, puis un seul saut", async () => {
    const { video, input, seekBar, preview, elapsed, onSeekRequest } = await bar({ trickplay: true, chapters: true });
    // Un survol seul : la vignette dit ce qui est sous le curseur, la barre et l'heure ne bougent pas.
    await act(async () => void fireEvent.mouseMove(seekBar, { clientX: 140 }));
    expect(preview()).toMatchObject({ time: "42:00", tile: { position: "-640px -900px" } });
    expect(Number(input.value)).toBe(0);
    expect(elapsed()).toBe("0:00");

    await act(async () => void fireEvent.mouseDown(input, { clientX: 50 }));
    await act(async () => void fireEvent.mouseMove(seekBar, { clientX: 50 }));
    // 50 / 200 d'une heure : 15 min, dans la planche 0, rangée 9.
    expect(preview()).toEqual({
      time: "15:00",
      chapter: "Ouverture",
      tile: { image: 'url("/api/jellyfin/trickplay/tile?itemId=item-1&width=320&index=0")', position: "0px -1620px" },
    });
    expect(elapsed()).toBe("15:00");

    await act(async () => void fireEvent.mouseMove(seekBar, { clientX: 140 }));
    // 42 min, dans la planche 2 (2 000–2 999 s), vignette 252 : rangée 5, colonne 2 ; chapitre « La traque ».
    expect(preview()).toEqual({
      time: "42:00",
      chapter: "La traque",
      tile: { image: 'url("/api/jellyfin/trickplay/tile?itemId=item-1&width=320&index=2")', position: "-640px -900px" },
    });
    expect(Number(input.value)).toBeCloseTo(2520, 0);
    expect(video.currentTime).toBe(0);
    expect(onSeekRequest).not.toHaveBeenCalled();

    await act(async () => void fireEvent.mouseUp(input, { clientX: 140 }));
    expect(onSeekRequest).toHaveBeenCalledTimes(1);
    expect(onSeekRequest.mock.calls[0][0]).toBeCloseTo(2520, 0);
    expect(video.currentTime).toBeCloseTo(2520, 0);
    expect(preview()).toBeNull();
  });

  it("au doigt : la vignette part de la position du film, suit le glissement, et le relâchement saute une fois", async () => {
    const { video, seekBar, preview, elapsed, onSeekRequest } = await bar({ trickplay: true });
    video.currentTime = 600;
    await act(async () => void video.dispatchEvent(new Event("timeupdate")));

    await act(async () => void fireEvent.touchStart(seekBar, { touches: [{ clientX: 150 }] }));
    expect(preview()).toEqual({
      time: "10:00",
      chapter: null,
      tile: { image: 'url("/api/jellyfin/trickplay/tile?itemId=item-1&width=320&index=0")', position: "0px -1080px" },
    });
    // +20 px sur 200 : +6 min, depuis la position et non depuis le doigt.
    await act(async () => void fireEvent.touchMove(seekBar, { touches: [{ clientX: 170 }] }));
    expect(preview()?.time).toBe("16:00");
    expect(preview()?.tile?.position).toBe("-1920px -1620px");
    expect(elapsed()).toBe("16:00");
    expect(onSeekRequest).not.toHaveBeenCalled();
    expect(video.currentTime).toBe(600);

    await act(async () => void fireEvent.touchEnd(seekBar));
    expect(onSeekRequest).toHaveBeenCalledTimes(1);
    expect(onSeekRequest.mock.calls[0][0]).toBeCloseTo(960, 0);
    expect(video.currentTime).toBeCloseTo(960, 0);
    expect(preview()).toBeNull();
  });

  it("sans aperçus, la vignette garde l'heure, sans planche", async () => {
    const { input, seekBar, preview } = await bar();
    await act(async () => void fireEvent.mouseDown(input, { clientX: 100 }));
    await act(async () => void fireEvent.mouseMove(seekBar, { clientX: 100 }));
    expect(preview()).toEqual({ time: "30:00", chapter: null, tile: null });
  });

  it("les commandes restent tant que la barre est sous le curseur ou le doigt, puis partent cinq secondes après", async () => {
    vi.useFakeTimers();
    const { video, input, seekBar, shown, root } = await bar();
    await startPlaying(video);

    // Le curseur qui survole.
    await act(async () => void fireEvent.mouseEnter(seekBar));
    await act(async () => void fireEvent.mouseMove(seekBar, { clientX: 60 }));
    await advance(20_000);
    expect(shown()).toBe(true);
    await act(async () => void fireEvent.mouseOut(seekBar, { relatedTarget: root }));
    await advance(4_900);
    expect(shown()).toBe(true);
    await advance(200);
    expect(shown()).toBe(false);

    // Le glissement à la souris, relâché.
    await act(async () => void fireEvent.mouseMove(seekBar, { clientX: 60 }));
    await act(async () => void fireEvent.mouseDown(input, { clientX: 60 }));
    await advance(20_000);
    expect(shown()).toBe(true);
    await act(async () => void fireEvent.mouseUp(input, { clientX: 80 }));
    await advance(4_900);
    expect(shown()).toBe(true);
    await advance(200);
    expect(shown()).toBe(false);

    // Le doigt.
    await act(async () => void fireEvent.touchStart(seekBar, { touches: [{ clientX: 100 }] }));
    expect(shown()).toBe(true);
    await advance(20_000);
    expect(shown()).toBe(true);
    await act(async () => void fireEvent.touchEnd(seekBar));
    await advance(4_900);
    expect(shown()).toBe(true);
    await advance(200);
    expect(shown()).toBe(false);
  });
});
