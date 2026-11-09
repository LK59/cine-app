// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, act, fireEvent, waitFor, renderHook } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useRef, type ReactNode, type RefObject } from "react";

/**
 * « À l'écran » en 10.27 (DECISIONS.md §138) : la rangée mesure les boutons du centre et s'arrête 16 px
 * avant eux (couché), se pose au-dessus du bloc du titre, paraît avec les commandes **en lecture comme en
 * pause**, suit les changements de scène en fondu sans jamais changer sous un doigt, et porte au bout un
 * bouton rond de la question, seul quand personne n'est reconnu. « Jusqu'ici » est préparé en fond pour les
 * trois premières personnes, une fois par tranche, jamais page cachée.
 */

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  useLocale: () => ({ locale: "fr" }),
}));

import { PlayerControls } from "@/components/PlayerControls";
import { PlayerOnScreen, ONSCREEN_FADE_MS, ONSCREEN_SETTLE_MS } from "@/components/playerControls/PlayerOnScreen";
import { useOnScreenPlacement } from "@/components/playerControls/useOnScreenPlacement";
import { onScreenRowBottom, onScreenRowWidth, ONSCREEN_CENTER_GAP_PX } from "@/lib/xray/client";
import { resetPrewarmForTests } from "@/lib/ask/client";
import type { XrayPlayerPayload, XrayPlayerPerson } from "@/lib/xray/scenes";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
beforeEach(() => resetPrewarmForTests());

const person = (personId: number, name: string, character: string, screenTime: number): XrayPlayerPerson => ({
  personId,
  name,
  character,
  photo: null,
  screenTime,
  confidence: 0.9,
});
const A = [person(1, "Leonardo DiCaprio", "Dom Cobb", 30), person(2, "Elliot Page", "Ariadne", 20)];
const B = [person(4, "Tom Hardy", "Eames", 25), person(5, "Ken Watanabe", "Saito", 10)];
const ids = (c: ParentNode) => Array.from(c.querySelectorAll("[data-onscreen-person]")).map((el) => Number(el.getAttribute("data-onscreen-person")));

describe("la place de la rangée", () => {
  const center = { left: 362, right: 482, top: 155, bottom: 235 };
  it("couché : elle partage la hauteur des boutons du centre — elle s'arrête 16 px avant leur bord gauche", () => {
    expect(onScreenRowWidth({ left: 44, right: 800, top: 170, bottom: 230 }, center)).toBe(362 - ONSCREEN_CENTER_GAP_PX - 44);
  });
  it("debout : les boutons sont loin au-dessus — toute la largeur", () => {
    expect(onScreenRowWidth({ left: 16, right: 374, top: 640, bottom: 700 }, { left: 95, right: 295, top: 380, bottom: 460 })).toBeNull();
    expect(onScreenRowWidth({ left: 16, right: 374, top: 640, bottom: 700 }, null)).toBeNull();
  });
  it("le bas : juste au-dessus du bloc du titre", () => {
    expect(onScreenRowBottom({ left: 0, right: 844, top: 0, bottom: 390 }, { left: 44, right: 800, top: 300, bottom: 340 })).toBe(390 - 300 + 10);
  });
  it("mesurée sur la page, et remesurée à la rotation", async () => {
    const rect = (r: { left: number; top: number; width: number; height: number }) => () =>
      ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON() {} }) as DOMRect;
    const chrome = document.createElement("div");
    const wrap = document.createElement("div");
    const row = document.createElement("div");
    row.setAttribute("data-player-onscreen", "");
    wrap.appendChild(row);
    chrome.appendChild(wrap);
    const title = document.createElement("div");
    const centerEl = document.createElement("div");
    document.body.append(chrome, title, centerEl);
    chrome.getBoundingClientRect = rect({ left: 0, top: 0, width: 844, height: 390 });
    row.getBoundingClientRect = rect({ left: 44, top: 0, width: 700, height: 60 });
    title.getBoundingClientRect = rect({ left: 44, top: 300, width: 700, height: 40 });
    centerEl.getBoundingClientRect = rect({ left: 362, top: 155, width: 120, height: 80 });
    const { result } = renderHook(() => useOnScreenPlacement({ wrap: { current: wrap }, center: { current: centerEl }, titleRow: { current: title } }, true));
    await waitFor(() => expect(result.current).toEqual({ bottom: 100, maxWidth: 362 - 16 - 44 }));
    // Debout : le centre remonte au milieu d'un écran haut, la rangée reprend toute la largeur.
    chrome.getBoundingClientRect = rect({ left: 0, top: 0, width: 390, height: 844 });
    row.getBoundingClientRect = rect({ left: 16, top: 0, width: 358, height: 60 });
    title.getBoundingClientRect = rect({ left: 16, top: 740, width: 358, height: 40 });
    centerEl.getBoundingClientRect = rect({ left: 95, top: 382, width: 200, height: 80 });
    act(() => void window.dispatchEvent(new Event("orientationchange")));
    await waitFor(() => expect(result.current).toEqual({ bottom: 844 - 740 + 10, maxWidth: null }));
    chrome.remove();
    title.remove();
    centerEl.remove();
  });
});

describe("la rangée suit la scène — jamais sous un doigt", () => {
  it("un changement de scène : les nouveaux visages en fondu, ceux qui partent s'effacent puis s'en vont", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<PlayerOnScreen people={A} visible onPick={() => {}} />);
    expect(ids(container)).toEqual([1, 2]);
    expect(container.querySelector(".player-onscreen-in")).toBeNull();
    rerender(<PlayerOnScreen people={[A[1], ...B]} visible onPick={() => {}} />);
    expect(ids(container)).toEqual([2, 4, 5]);
    expect(container.querySelector('[data-onscreen-person="4"]')!.className).toContain("player-onscreen-in");
    // Elle était déjà là : pas de fondu.
    expect(container.querySelector('[data-onscreen-person="2"]')!.className).not.toContain("player-onscreen-in");
    const leaving = container.querySelector('[data-onscreen-leaving="1"]')!;
    expect(leaving.className).toContain("player-onscreen-out");
    expect(leaving.getAttribute("aria-hidden")).toBe("true");
    act(() => void vi.advanceTimersByTime(ONSCREEN_FADE_MS + 10));
    expect(container.querySelector("[data-onscreen-leaving]")).toBeNull();
  });

  it("pendant qu'on fait défiler la rangée, elle garde ce qu'elle montre ; puis rattrape la scène", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<PlayerOnScreen people={A} visible onPick={() => {}} />);
    const row = container.querySelector("[data-onscreen-row]")!;
    fireEvent.pointerDown(row);
    rerender(<PlayerOnScreen people={B} visible onPick={() => {}} />);
    expect(ids(container)).toEqual([1, 2]);
    fireEvent.scroll(row);
    fireEvent.pointerUp(row);
    act(() => void vi.advanceTimersByTime(ONSCREEN_SETTLE_MS - 50));
    rerender(<PlayerOnScreen people={B} visible onPick={() => {}} />);
    expect(ids(container)).toEqual([1, 2]);
    act(() => void vi.advanceTimersByTime(100));
    expect(ids(container)).toEqual([4, 5]);
  });

  it("couché, la largeur mesurée est posée : la rangée défile dedans, le bouton rond reste au bout", () => {
    const { container } = render(<PlayerOnScreen people={A} visible onPick={() => {}} maxWidth={302} trailing={<button data-player-nav="ask" />} />);
    expect(container.querySelector<HTMLElement>("[data-player-onscreen]")!.style.maxWidth).toBe("302px");
    expect(container.querySelector("[data-onscreen-row]")!.contains(container.querySelector('[data-player-nav="ask"]'))).toBe(false);
  });
});

// ── Dans le lecteur ─────────────────────────────────────────────────────────────────────────────

const PAYLOAD: XrayPlayerPayload = {
  status: "done",
  complete: true,
  analyzedUntil: 2000,
  scenes: [
    { start: 0, end: 50, people: [...A, person(3, "Tom Berenger", "Browning", 5), person(6, "Michael Caine", "Miles", 1)] },
    { start: 50, end: 120, people: [] },
    { start: 600, end: 700, people: A },
  ],
};

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
        onClose={() => {}}
        onMinimize={() => {}}
        onTogglePlaybackInfo={() => {}}
        audioTracks={[]}
        currentAudioId={null}
        onChangeAudio={() => {}}
        subtitleTracks={[]}
        currentSubtitleId={null}
        onChangeSubtitle={() => {}}
        hidden={false}
        loading={false}
        introSkip={null}
        creditsStart={null}
        nextEpisode={null}
        onAdvance={() => {}}
        {...props}
      />
    </div>
  );
}
function withConfig(pub: Record<string, unknown>, node: ReactNode) {
  return render(<SWRConfig value={{ provider: () => new Map([["/api/config/public", { data: pub }]]) }}>{node}</SWRConfig>);
}
function stubFetch() {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
    String(url).startsWith("/api/player/xray/") ? new Response(JSON.stringify(PAYLOAD)) : new Response(JSON.stringify({ t: "queued" }) + "\n")
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const prewarms = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls
    .filter(([url, init]) => String(url).startsWith("/api/cinema/ask/") && (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { mode: string; personId: number; prewarm: boolean; positionS: number });

async function at(video: HTMLVideoElement, t: number, playing: boolean) {
  Object.defineProperty(video, "duration", { value: 3000, configurable: true });
  Object.defineProperty(video, "currentTime", { value: t, writable: true, configurable: true });
  Object.defineProperty(video, "paused", { value: !playing, configurable: true });
  await act(async () => void video.dispatchEvent(new Event("durationchange")));
  await act(async () => void video.dispatchEvent(new Event(playing ? "playing" : "pause")));
  await act(async () => void video.dispatchEvent(new Event("timeupdate")));
}

describe("dans le lecteur : avec les commandes, en lecture comme en pause", () => {
  it("film en lecture, commandes affichées : la rangée et le bouton rond de la question", async () => {
    stubFetch();
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig({ xrayAvailable: true, askAvailable: true }, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 10, true);
    await waitFor(() => expect(container.querySelector("[data-player-onscreen]")).toBeTruthy());
    const ask = container.querySelector<HTMLElement>('[data-player-nav="ask"]')!;
    // Une icône seule, nommée pour les lecteurs d'écran.
    expect(ask.textContent).toBe("");
    expect(ask.getAttribute("aria-label")).toBe("ask.title");
    // La rangée part avec les commandes : dans la couche des commandes, qui porte leur état.
    expect(container.querySelector("[data-chrome]")!.contains(container.querySelector("[data-player-onscreen]"))).toBe(true);
  });

  it("personne de reconnu : le bouton rond seul, sans rangée", async () => {
    stubFetch();
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig({ xrayAvailable: true, askAvailable: true }, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 60, true);
    await waitFor(() => expect(container.querySelector('[data-player-nav="ask"]')).toBeTruthy());
    expect(container.querySelector("[data-player-onscreen]")).toBeNull();
  });

  it("sans l'option des questions : la rangée sans bouton ; une personne touchée ouvre son panneau quand même", async () => {
    const fetchMock = stubFetch();
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig({ xrayAvailable: true, askAvailable: false }, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 10, false);
    const pill = await waitFor(() => container.querySelector<HTMLElement>('[data-onscreen-person="2"]')!);
    expect(container.querySelector('[data-player-nav="ask"]')).toBeNull();
    fireEvent.click(pill);
    const dialog = await waitFor(() => container.querySelector<HTMLElement>("[data-ask-panel]")!);
    expect(dialog.querySelector('[data-ask-person="2"]')).toBeTruthy();
    expect(dialog.querySelector("[data-ask-input]")).toBeNull();
    expect(dialog.querySelector("[data-ask-sofar]")).toBeNull();
    // Ni question, ni « Jusqu'ici », ni préparation : rien ne part vers la route des questions.
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/cinema/ask/"))).toBe(false);
  });

  it("« Jusqu'ici » préparé en fond : les trois premières personnes, une fois par tranche de dix minutes", async () => {
    const fetchMock = stubFetch();
    let video: HTMLVideoElement | null = null;
    withConfig({ xrayAvailable: true, askAvailable: true }, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 10, true);
    await waitFor(() => expect(prewarms(fetchMock)).toHaveLength(3));
    expect(prewarms(fetchMock).map((b) => b.personId)).toEqual([1, 2, 3]);
    expect(prewarms(fetchMock).every((b) => b.mode === "jusquici" && b.prewarm)).toBe(true);
    // Même scène, même tranche : rien de plus.
    await at(video!, 20, false);
    await at(video!, 30, true);
    expect(prewarms(fetchMock)).toHaveLength(3);
    // Une autre tranche : de nouveau, pour les personnes de la scène.
    await at(video!, 610, true);
    await waitFor(() => expect(prewarms(fetchMock)).toHaveLength(5));
  });

  it("page cachée : aucune préparation, même dans une nouvelle tranche", async () => {
    const fetchMock = stubFetch();
    let video: HTMLVideoElement | null = null;
    withConfig({ xrayAvailable: true, askAvailable: true }, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 10, true);
    await waitFor(() => expect(prewarms(fetchMock)).toHaveLength(3));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      await at(video!, 610, true);
      await act(async () => {});
      expect(prewarms(fetchMock)).toHaveLength(3);
    } finally {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    }
  });
});
