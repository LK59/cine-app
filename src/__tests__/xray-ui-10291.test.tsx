// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { endOnScreenSession, forgetOnScreenSessions } from "@/lib/onScreenSession";
import { useRef, type ReactNode, type RefObject } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * « À l'écran » en 10.29.1 (DECISIONS.md §138) — l'iPhone du propriétaire, *Ted Lasso* S01E08, scène de 599 s :
 * cinq personnes, la rangée déborde ; des touchers l'ont fait disparaître puis revenir vide, et le panneau de Roy
 * n'a pas paru. L'état rejoué était juste ; la piste est un défaut de rendu de WebKit (un masque sur ce qui porte
 * du flou, un `background-clip: text` animé dans un panneau flouté). Ce fichier tient :
 * - le fondu du bord : un voile à part, monté seulement quand la rangée déborde, plus aucun masque ;
 * - le geste des pilules et du bouton rond : celui des autres pilules du lecteur, jamais pendant le défilement ;
 * - le relevé `xray-ui` : borné, sur un écran tactile seulement, et ce qu'il dit de la rangée et d'un toucher.
 */

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  useLocale: () => ({ locale: "fr" }),
}));

import { PlayerControls } from "@/components/PlayerControls";
import { PlayerOnScreen, ONSCREEN_SCROLLING_MS } from "@/components/playerControls/PlayerOnScreen";
import { createXrayUiDiag, hitAt, XRAY_UI_DIAG_MAX, XRAY_UI_ROW_MAX } from "@/lib/xrayUiDiag";
import { resetPrewarmForTests, resetSofarClientForTests } from "@/lib/ask/client";
import type { XrayPlayerPayload, XrayPlayerPerson } from "@/lib/xray/scenes";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  resetPrewarmForTests();
  resetSofarClientForTests();
});

const person = (personId: number, name: string, character: string, screenTime: number): XrayPlayerPerson => ({
  personId,
  name,
  character,
  photo: null,
  screenTime,
  confidence: 0.9,
});
const FIVE = [
  person(1, "Jason Sudeikis", "Ted Lasso", 50),
  person(2, "Brett Goldstein", "Roy Kent", 40),
  person(3, "Juno Temple", "Keeley Jones", 30),
  person(4, "Phil Dunster", "Jamie Tartt", 20),
  person(5, "Brendan Hunt", "Coach Beard", 10),
];
const frame = () => act(async () => void (await new Promise((r) => requestAnimationFrame(() => r(null)))));
/** jsdom ne fait pas de mise en page : la rangée déborde quand on le lui dit. */
function overflowing(row: Element, scrollWidth: number, clientWidth: number) {
  Object.defineProperty(row, "scrollWidth", { value: scrollWidth, configurable: true });
  Object.defineProperty(row, "clientWidth", { value: clientWidth, configurable: true });
  Object.defineProperty(row, "scrollLeft", { value: 0, writable: true, configurable: true });
}

describe("le fondu du bord : un voile à part, plus un masque", () => {
  it("la rangée déborde : un voile sans pointeur, après les pilules et avant la flèche ; aucun masque sur la rangée", async () => {
    const { container } = render(<PlayerOnScreen people={FIVE} visible onPick={() => {}} trailing={<button data-trailing="">?</button>} />);
    const row = container.querySelector<HTMLElement>("[data-onscreen-row]")!;
    expect(container.querySelector("[data-onscreen-fade]")).toBeNull();
    overflowing(row, 900, 320);
    fireEvent.scroll(row);
    const fade = await waitFor(() => container.querySelector<HTMLElement>("[data-onscreen-fade]")!);
    expect(fade.getAttribute("aria-hidden")).toBe("true");
    expect(fade.className).toContain("pointer-events-none");
    // Il part avec les commandes, comme chaque pilule.
    expect(fade.className).toContain("player-fade");
    // Hors de ce qui défile, au-dessus des pilules (après elles), sous la flèche (avant elle).
    expect(row.contains(fade)).toBe(false);
    expect(row.compareDocumentPosition(fade) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const next = container.querySelector("[data-onscreen-arrow='next']")!;
    expect(fade.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Aucun masque : ni classe, ni style, sur la rangée ni sur ce qui la porte.
    for (let el: HTMLElement | null = row; el && el !== container; el = el.parentElement) {
      expect(el.className).not.toMatch(/more|mask/);
      expect(el.getAttribute("style") ?? "").not.toMatch(/mask/);
    }
  });

  it("au bout de la rangée (plus rien après) : le voile s'en va", async () => {
    const { container } = render(<PlayerOnScreen people={FIVE} visible onPick={() => {}} />);
    const row = container.querySelector<HTMLElement>("[data-onscreen-row]")!;
    overflowing(row, 900, 320);
    fireEvent.scroll(row);
    await waitFor(() => expect(container.querySelector("[data-onscreen-fade]")).toBeTruthy());
    row.scrollLeft = 580;
    fireEvent.scroll(row);
    await waitFor(() => expect(container.querySelector("[data-onscreen-fade]")).toBeNull());
  });

  it("la feuille de style : plus de `mask-image` pour « À l'écran », plus de `background-clip: text` dans le panneau des questions", () => {
    const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // Chaque règle du lecteur ou du panneau qui nommerait un masque ou un texte détouré.
    const rules = css.match(/[^{}]+\{[^{}]*\}/g) ?? [];
    for (const rule of rules) {
      const [selector, body] = rule.split("{");
      if (/player-onscreen|ask-/.test(selector)) {
        expect(body, selector).not.toMatch(/mask-image|background-clip\s*:\s*text/);
      }
    }
    expect(css).not.toMatch(/\.player-onscreen-more\b/);
    expect(css).not.toMatch(/\.ask-wait-shimmer\b/);
    expect(css).toMatch(/\.player-onscreen-fade\s*\{/);
  });
});

describe("le geste des pilules : celui des autres pilules du lecteur", () => {
  it("chaque pilule porte le geste « posé dans ce qu'on fait glisser » ; celle qui s'efface, non", () => {
    const { container, rerender } = render(<PlayerOnScreen people={FIVE.slice(0, 2)} visible onPick={() => {}} />);
    expect(container.querySelector('[data-onscreen-person="1"]')!.getAttribute("data-liquid-pan")).toBe("press");
    rerender(<PlayerOnScreen people={FIVE.slice(1, 3)} visible onPick={() => {}} />);
    expect(container.querySelector('[data-onscreen-leaving="1"]')!.hasAttribute("data-liquid-pan")).toBe(false);
  });

  it("la rangée défile : marquée `data-onscreen-scrolling` le temps de l'élan, puis plus", () => {
    vi.useFakeTimers();
    const { container } = render(<PlayerOnScreen people={FIVE} visible onPick={() => {}} />);
    const row = container.querySelector<HTMLElement>("[data-onscreen-row]")!;
    fireEvent.scroll(row);
    expect(row.hasAttribute("data-onscreen-scrolling")).toBe(true);
    act(() => void vi.advanceTimersByTime(ONSCREEN_SCROLLING_MS + 10));
    expect(row.hasAttribute("data-onscreen-scrolling")).toBe(false);
  });
});

// ── Dans le lecteur ─────────────────────────────────────────────────────────────────────────────

const PAYLOAD: XrayPlayerPayload = {
  status: "done",
  complete: true,
  analyzedUntil: 2000,
  scenes: [{ start: 599, end: 700, people: FIVE }],
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
async function at(video: HTMLVideoElement, t: number, playing: boolean) {
  Object.defineProperty(video, "duration", { value: 3000, configurable: true });
  Object.defineProperty(video, "currentTime", { value: t, writable: true, configurable: true });
  Object.defineProperty(video, "paused", { value: !playing, configurable: true });
  await act(async () => void video.dispatchEvent(new Event("durationchange")));
  await act(async () => void video.dispatchEvent(new Event(playing ? "playing" : "pause")));
  await act(async () => void video.dispatchEvent(new Event("timeupdate")));
}
const touch = (type: string, x = 10, y = 10) => new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: "touch" });
/** Un écran tactile : le relevé `xray-ui` ne part que là. */
function coarse() {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("pointer: coarse"), media: q, addEventListener() {}, removeEventListener() {} }));
}
const diagPosts = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls
    .filter(([url]) => String(url) === "/api/viewport-diag")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
const CONFIG = { xrayAvailable: true, askAvailable: true, askPersonAvailable: true, sofarAvailable: true };

/** « À l'écran » est masquée par défaut depuis le 13/11/2026 : le bouton rond de gauche l'ouvre. */
async function openRow(container: HTMLElement) {
  const toggle = await waitFor(() => container.querySelector<HTMLElement>('[data-player-nav="onscreen"]')!);
  fireEvent.click(toggle);
  await waitFor(() => expect(container.querySelector('[data-onscreen-open="true"]')).toBeTruthy());
}
// Le choix ouvert/fermé tient la séance de l'élément (`onScreenSession.ts`) : chaque test repart masqué.
beforeEach(() => forgetOnScreenSessions());

describe("dans le lecteur : le geste sous le doigt", () => {
  // jsdom ne pose rien : le geste ne vise qu'un bouton qui a une largeur, et sous le doigt (la boîte est à 0,0).
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(40);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(40);
  });
  afterEach(() => vi.restoreAllMocks());
  it("un doigt posé sur une pilule : elle gonfle et s'allume ; levé, elle revient — et le clic l'ouvre comme avant", async () => {
    stubFetch();
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig(CONFIG, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 610, false);
    await openRow(container);
    const pill = await waitFor(() => container.querySelector<HTMLElement>('[data-onscreen-person="2"]')!);
    act(() => void pill.dispatchEvent(touch("pointerdown", 0, 0)));
    expect(pill.style.transform).toMatch(/scale/);
    expect(pill.hasAttribute("data-lit")).toBe(true);
    act(() => void window.dispatchEvent(touch("pointerup", 0, 0)));
    expect(pill.style.transform).toBe("");
    expect(pill.hasAttribute("data-lit")).toBe(false);
    fireEvent.click(pill);
    await waitFor(() => expect(container.querySelector("[data-ask-panel] [data-ask-person='2']")).toBeTruthy());
  });

  it("un doigt qui part de côté (la rangée défile) : le geste rend la main, rien ne s'ouvre", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch();
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig(CONFIG, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 610, false);
    await openRow(container);
    const pill = await waitFor(() => container.querySelector<HTMLElement>('[data-onscreen-person="2"]')!);
    act(() => void pill.dispatchEvent(touch("pointerdown", 10, 10)));
    act(() => void window.dispatchEvent(touch("pointermove", 40, 11)));
    act(() => void window.dispatchEvent(touch("pointerup", 60, 11)));
    expect(pill.hasAttribute("data-lit")).toBe(false);
    await act(async () => void (await vi.advanceTimersByTimeAsync(400)));
    expect(container.querySelector("[data-ask-panel]")).toBeNull();
  });

  it("un appui pendant que la rangée défile encore (l'élan) : il l'arrête, rien ne gonfle", async () => {
    stubFetch();
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig(CONFIG, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 610, false);
    await openRow(container);
    const pill = await waitFor(() => container.querySelector<HTMLElement>('[data-onscreen-person="2"]')!);
    fireEvent.scroll(container.querySelector("[data-onscreen-row]")!);
    act(() => void pill.dispatchEvent(touch("pointerdown")));
    expect(pill.style.transform).toBe("");
    expect(pill.hasAttribute("data-lit")).toBe(false);
    act(() => void window.dispatchEvent(touch("pointerup")));
  });

  it("le bouton rond de la question : le geste du rond seul des commandes (gonfle, s'allume)", async () => {
    stubFetch();
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig(CONFIG, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 610, false);
    await openRow(container);
    const ask = await waitFor(() => container.querySelector<HTMLElement>('[data-player-nav="ask"]')!);
    act(() => void ask.dispatchEvent(touch("pointerdown", 0, 0)));
    expect(ask.style.transform).toMatch(/scale/);
    expect(ask.hasAttribute("data-lit")).toBe(true);
    act(() => void window.dispatchEvent(touch("pointerup", 0, 0)));
    expect(ask.hasAttribute("data-lit")).toBe(false);
  });
});

describe("le relevé `xray-ui` (10.29.1)", () => {
  it("borné : douze lignes par séance, dont cinq pour la rangée ; rien à la souris", () => {
    const posted: Record<string, unknown>[] = [];
    const diag = createXrayUiDiag("item-1", { enabled: true, post: (b) => void posted.push(b) });
    for (let i = 0; i < 9; i++) diag.send("row", { pills: i });
    expect(posted).toHaveLength(XRAY_UI_ROW_MAX);
    for (let i = 0; i < 20; i++) diag.send("tap", { personId: i });
    expect(posted).toHaveLength(XRAY_UI_DIAG_MAX);
    expect(posted[0]).toMatchObject({ kind: "xray-ui", event: "row", itemId: "item-1", seq: 1 });
    expect(new Set(posted.map((p) => p.session)).size).toBe(1);
    const off: unknown[] = [];
    createXrayUiDiag("item-1", { enabled: false, post: (b) => void off.push(b) }).send("tap", {});
    expect(off).toHaveLength(0);
  });

  it("ce qui est dessus au centre du panneau : le panneau, son fond, ou un autre élément nommé", () => {
    const panel = document.createElement("section");
    const inner = document.createElement("p");
    panel.append(inner);
    const backdrop = document.createElement("div");
    const video = document.createElement("video");
    video.setAttribute("data-player-video", "");
    const box = { x: 0, y: 0, w: 100, h: 100 };
    const doc = (hit: Element | null) => ({ elementFromPoint: () => hit }) as unknown as Document;
    expect(hitAt(doc(inner), box, panel, backdrop)).toBe("panneau");
    expect(hitAt(doc(backdrop), box, panel, backdrop)).toBe("fond");
    expect(hitAt(doc(video), box, panel, backdrop)).toBe("video[data-player-video]");
    expect(hitAt(doc(null), box, panel, backdrop)).toBe("rien");
    expect(hitAt(doc(inner), null, panel, backdrop)).toBeNull();
  });

  it("dans le lecteur, au doigt : la rangée montrée (scène, pilules, débordement), le toucher, le panneau puis sa fermeture", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    coarse();
    const fetchMock = stubFetch();
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig(CONFIG, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 610, false);
    await openRow(container);
    const pill = await waitFor(() => container.querySelector<HTMLElement>('[data-onscreen-person="2"]')!);
    await frame();
    await waitFor(() => expect(diagPosts(fetchMock).some((p) => p.event === "row")).toBe(true));
    const row = diagPosts(fetchMock).find((p) => p.event === "row")!;
    expect(row).toMatchObject({ kind: "xray-ui", trigger: "montée", sceneStart: 599, pills: 5, itemId: "item-1" });
    expect(row).toHaveProperty("row");
    expect(row).toHaveProperty("first");
    fireEvent.click(pill);
    expect(diagPosts(fetchMock).find((p) => p.event === "tap")).toMatchObject({ personId: 2, pills: 5 });
    await waitFor(() => expect(container.querySelector("[data-ask-panel]")).toBeTruthy());
    await act(async () => void (await vi.advanceTimersByTimeAsync(350)));
    expect(diagPosts(fetchMock).find((p) => p.event === "open")).toMatchObject({ personId: 2 });
    fireEvent.click(container.querySelector("[data-ask-backdrop]")!);
    await act(async () => void (await vi.advanceTimersByTimeAsync(300)));
    await waitFor(() => expect(diagPosts(fetchMock).find((p) => p.event === "close")).toMatchObject({ personId: 2, reason: "fond" }));
    // La rangée revient : une ligne de plus, montée à nouveau.
    await frame();
    await waitFor(() => expect(diagPosts(fetchMock).filter((p) => p.event === "row")).toHaveLength(2));
    expect(diagPosts(fetchMock).length).toBeLessThanOrEqual(XRAY_UI_DIAG_MAX);
  });

  it("à la souris (pointeur fin) : rien ne part", async () => {
    const fetchMock = stubFetch();
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig(CONFIG, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 610, false);
    await openRow(container);
    const pill = await waitFor(() => container.querySelector<HTMLElement>('[data-onscreen-person="2"]')!);
    await frame();
    fireEvent.click(pill);
    await waitFor(() => expect(container.querySelector("[data-ask-panel]")).toBeTruthy());
    expect(diagPosts(fetchMock)).toHaveLength(0);
  });
});

describe("« À l'écran » à la demande (13/11/2026)", () => {
  afterEach(() => vi.restoreAllMocks());
  const wrapOf = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-onscreen-wrap]")!;
  const toggleOf = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-player-nav="onscreen"]')!;

  it("masquée par défaut, même en pause : le bouton rond seul, la rangée inerte, la question hors d'atteinte", async () => {
    stubFetch();
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig(CONFIG, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 610, false);
    await waitFor(() => expect(toggleOf(container)).toBeTruthy());
    expect(wrapOf(container).getAttribute("data-onscreen-open")).toBe("false");
    expect(toggleOf(container).getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[data-onscreen-body]")!.hasAttribute("inert")).toBe(true);
    expect(container.querySelector('[data-player-nav="ask"]')!.className).toContain("pointer-events-none");
  });

  it("le bouton ouvre puis referme ; le choix tient la séance, et la suivante repart masquée", async () => {
    stubFetch();
    let video: HTMLVideoElement | null = null;
    const first = withConfig(CONFIG, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 610, true);
    await openRow(first.container);
    expect(toggleOf(first.container).getAttribute("aria-expanded")).toBe("true");
    expect(first.container.querySelector('[data-player-nav="ask"]')!.className).toContain("pointer-events-auto");
    // Une reconstruction remonte les commandes : la rangée reste ouverte.
    first.unmount();
    const second = withConfig(CONFIG, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 610, true);
    await waitFor(() => expect(wrapOf(second.container).getAttribute("data-onscreen-open")).toBe("true"));
    fireEvent.click(toggleOf(second.container));
    expect(wrapOf(second.container).getAttribute("data-onscreen-open")).toBe("false");
    fireEvent.click(toggleOf(second.container));
    second.unmount();
    // La ligne `stop` partie : la séance suivante repart masquée.
    endOnScreenSession("item-1");
    const third = withConfig(CONFIG, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 610, true);
    await waitFor(() => expect(toggleOf(third.container)).toBeTruthy());
    expect(wrapOf(third.container).getAttribute("data-onscreen-open")).toBe("false");
  });

  it("elle suit les commandes : cachées puis rappelées, elle revient dépliée — sauf après une minute cachées", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      stubFetch();
      let video: HTMLVideoElement | null = null;
      const { container } = withConfig(CONFIG, <Harness onVideoRef={(v) => (video = v)} />);
      await at(video!, 610, true);
      await openRow(container);
      const chrome = () => container.querySelector("[data-chrome]")?.getAttribute("data-chrome");
      const surface = container.querySelector<HTMLElement>(".player-liquid")!;
      // Un toucher sur l'image affiche ou masque les commandes : la rangée ne les retient pas.
      const tap = async () => {
        await act(async () => void surface.dispatchEvent(touch("pointerdown", 300, 300)));
        await act(async () => void fireEvent.click(surface));
      };
      await tap();
      expect(chrome()).toBe("hidden");
      // Rappelées avant la minute : toujours dépliée.
      await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
      await tap();
      expect(chrome()).toBe("shown");
      expect(wrapOf(container).getAttribute("data-onscreen-open")).toBe("true");
      // Cachées une minute de suite : repliée sans bruit, et les commandes rappelées reviennent sans elle.
      await tap();
      expect(chrome()).toBe("hidden");
      await act(async () => void (await vi.advanceTimersByTimeAsync(61_000)));
      await tap();
      expect(chrome()).toBe("shown");
      expect(wrapOf(container).getAttribute("data-onscreen-open")).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("la touche I ouvre et ferme ; un glissement au doigt vers le haut ouvre, vers le bas ferme", async () => {
    stubFetch();
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig(CONFIG, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 610, false);
    await waitFor(() => expect(toggleOf(container)).toBeTruthy());
    await act(async () => void fireEvent.keyDown(window, { key: "i", code: "KeyI" }));
    expect(wrapOf(container).getAttribute("data-onscreen-open")).toBe("true");
    await act(async () => void fireEvent.keyDown(window, { key: "i", code: "KeyI" }));
    expect(wrapOf(container).getAttribute("data-onscreen-open")).toBe("false");
    const surface = container.querySelector<HTMLElement>(".player-liquid")!;
    fireEvent.touchStart(surface, { touches: [{ clientX: 200, clientY: 300 }] });
    fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 205, clientY: 220 }] });
    expect(wrapOf(container).getAttribute("data-onscreen-open")).toBe("true");
    // De côté plutôt que vers le bas : rien.
    fireEvent.touchStart(surface, { touches: [{ clientX: 100, clientY: 200 }] });
    fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 220, clientY: 260 }] });
    expect(wrapOf(container).getAttribute("data-onscreen-open")).toBe("true");
    fireEvent.touchStart(surface, { touches: [{ clientX: 200, clientY: 200 }] });
    fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 195, clientY: 290 }] });
    expect(wrapOf(container).getAttribute("data-onscreen-open")).toBe("false");
  });
});
