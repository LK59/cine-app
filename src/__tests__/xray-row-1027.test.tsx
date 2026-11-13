// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, act, fireEvent, waitFor, renderHook, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useRef, type ReactNode, type RefObject } from "react";

/**
 * « À l'écran » en 10.27 (DECISIONS.md §138) : la rangée va aussi loin que possible à droite et ne
 * s'arrête 16 px avant les boutons du centre ou la pilule des outils que s'ils partagent sa hauteur (10.27.1), se pose au-dessus du bloc du titre, paraît avec les commandes **en lecture comme en
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
import { prewarmSofar, resetPrewarmForTests, resetSofarClientForTests, SOFAR_HOVER_INTENT_MS } from "@/lib/ask/client";
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
const A = [person(1, "Leonardo DiCaprio", "Dom Cobb", 30), person(2, "Elliot Page", "Ariadne", 20)];
const B = [person(4, "Tom Hardy", "Eames", 25), person(5, "Ken Watanabe", "Saito", 10)];
const ids = (c: ParentNode) => Array.from(c.querySelectorAll("[data-onscreen-person]")).map((el) => Number(el.getAttribute("data-onscreen-person")));

describe("la place de la rangée (10.27.1 : aussi loin que possible à droite)", () => {
  // L'iPhone couché du propriétaire (932 × 430) : la ligne des pilules sous les boutons du centre, la pilule
  // des outils en bas à droite, dans la rangée du titre.
  const line = { left: 59, right: 873, top: 262, bottom: 306 };
  const center = { left: 336, right: 596, top: 183, bottom: 247 };
  const tools = { left: 640, right: 873, top: 318, bottom: 362 };
  it("les boutons du centre au-dessus, sans chevauchement : elle n'est pas arrêtée par eux (10.27.0 l'arrêtait au tiers)", () => {
    expect(onScreenRowWidth(line, { center, tools })).toBeNull();
    // Se toucher par un bord n'est pas se chevaucher.
    expect(onScreenRowWidth({ ...line, top: 247 }, { center, tools })).toBeNull();
  });
  it("chevauchement avec le groupe du centre : 16 px avant son bord gauche", () => {
    expect(onScreenRowWidth({ ...line, top: 200, bottom: 244 }, { center, tools })).toBe(336 - ONSCREEN_CENTER_GAP_PX - 59);
    // Le centre passe avant la pilule des outils, même si les deux chevauchent.
    expect(onScreenRowWidth({ ...line, top: 230, bottom: 330 }, { center, tools })).toBe(336 - ONSCREEN_CENTER_GAP_PX - 59);
  });
  it("chevauchement avec la pilule des outils seulement : 16 px avant elle", () => {
    expect(onScreenRowWidth({ ...line, top: 300, bottom: 344 }, { center, tools })).toBe(640 - ONSCREEN_CENTER_GAP_PX - 59);
  });
  it("debout : les boutons loin au-dessus, les outils dessous — toute la largeur, jusqu'au bord sûr", () => {
    const portraitLine = { left: 16, right: 374, top: 640, bottom: 684 };
    expect(onScreenRowWidth(portraitLine, { center: { left: 95, right: 295, top: 380, bottom: 460 }, tools: { left: 180, right: 374, top: 700, bottom: 744 } })).toBeNull();
    expect(onScreenRowWidth(portraitLine, { center: null, tools: null })).toBeNull();
  });
  it("une pilule n'a pas de largeur à elle : un nom n'est coupé que si la rangée entière manque de place", () => {
    const { container } = render(<PlayerOnScreen people={[person(9, "Hannah Waddingh", "Rebecca Welton", 30)]} visible onPick={() => {}} trailing={<button data-trailing="">?</button>} />);
    const pill = container.querySelector<HTMLElement>('[data-onscreen-person="9"]')!;
    expect(pill.className).toContain("max-w-full");
    for (const el of pill.querySelectorAll("span")) expect(el.className).not.toMatch(/max-w-\[/);
    // Le bouton rond de la question reste au bout de la ligne, hors de ce qui défile.
    const line = container.querySelector("[data-onscreen-line]")!;
    expect(line.lastElementChild?.getAttribute("data-trailing")).toBe("");
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
    const pills = document.createElement("div");
    pills.setAttribute("data-onscreen-line", "");
    row.appendChild(pills);
    wrap.appendChild(row);
    chrome.appendChild(wrap);
    const title = document.createElement("div");
    const centerEl = document.createElement("div");
    const toolsEl = document.createElement("div");
    document.body.append(chrome, title, centerEl, toolsEl);
    chrome.getBoundingClientRect = rect({ left: 0, top: 0, width: 844, height: 390 });
    row.getBoundingClientRect = rect({ left: 44, top: 0, width: 700, height: 60 });
    pills.getBoundingClientRect = rect({ left: 44, top: 16, width: 700, height: 44 });
    title.getBoundingClientRect = rect({ left: 44, top: 300, width: 700, height: 40 });
    toolsEl.getBoundingClientRect = rect({ left: 600, top: 300, width: 200, height: 40 });
    // Le centre chevauche la ligne des pilules (bas 290, haut 246) : arrêtée 16 px avant lui.
    centerEl.getBoundingClientRect = rect({ left: 362, top: 200, width: 120, height: 80 });
    const refs = { wrap: { current: wrap }, center: { current: centerEl }, titleRow: { current: title }, tools: { current: toolsEl } };
    const { result } = renderHook(() => useOnScreenPlacement(refs, true));
    await waitFor(() => expect(result.current).toEqual({ bottom: 100, maxWidth: 362 - 16 - 44 }));
    // Le centre au-dessus, sans toucher la ligne (l'étiquette seule l'atteindrait) : toute la largeur.
    centerEl.getBoundingClientRect = rect({ left: 362, top: 150, width: 120, height: 80 });
    act(() => void window.dispatchEvent(new Event("resize")));
    await waitFor(() => expect(result.current).toEqual({ bottom: 100, maxWidth: null }));
    // Debout : le centre remonte au milieu d'un écran haut, la rangée reprend toute la largeur.
    chrome.getBoundingClientRect = rect({ left: 0, top: 0, width: 390, height: 844 });
    row.getBoundingClientRect = rect({ left: 16, top: 0, width: 358, height: 60 });
    pills.getBoundingClientRect = rect({ left: 16, top: 16, width: 358, height: 44 });
    toolsEl.getBoundingClientRect = rect({ left: 180, top: 740, width: 194, height: 40 });
    title.getBoundingClientRect = rect({ left: 16, top: 740, width: 358, height: 40 });
    centerEl.getBoundingClientRect = rect({ left: 95, top: 382, width: 200, height: 80 });
    act(() => void window.dispatchEvent(new Event("orientationchange")));
    await waitFor(() => expect(result.current).toEqual({ bottom: 844 - 740 + 10, maxWidth: null }));
    chrome.remove();
    title.remove();
    centerEl.remove();
    toolsEl.remove();
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

describe("la rangée commence au début (10.27.2 : elle s'ouvrait au bout sur l'iPhone)", () => {
  // jsdom ne fait ni mise en page ni aimantation : la position de la rangée est une valeur posée à la main,
  // comme l'aimantation de WebKit la poserait après une mise en page (la pilule suivie jusqu'au bout).
  function scrollable(row: Element, at: number) {
    Object.defineProperty(row, "scrollLeft", { value: at, writable: true, configurable: true });
  }
  const frame = () => act(async () => void (await new Promise((r) => requestAnimationFrame(() => r(null)))));
  const C = [person(7, "Juno Temple", "Keeley", 40), person(8, "Brett Goldstein", "Roy Kent", 35), ...A, ...B];

  it("à l'ouverture : une rangée portée au bout par la première mise en page revient à la première pilule", async () => {
    const { container } = render(<PlayerOnScreen people={C} visible onPick={() => {}} />);
    const row = container.querySelector("[data-onscreen-row]")!;
    scrollable(row, 420);
    await frame();
    expect(row.scrollLeft).toBe(0);
  });

  it("à chaque changement de scène : au début, même si la rangée était ailleurs", async () => {
    const { container, rerender } = render(<PlayerOnScreen people={A} visible onPick={() => {}} />);
    const row = container.querySelector("[data-onscreen-row]")!;
    scrollable(row, 260);
    rerender(<PlayerOnScreen people={C} visible onPick={() => {}} />);
    expect(row.scrollLeft).toBe(0);
    // Et si l'aimantation la repousse après la mise en page, l'image suivante la ramène.
    scrollable(row, 300);
    await frame();
    expect(row.scrollLeft).toBe(0);
  });

  it("une largeur permise qui change (la place mesurée après l'ouverture) : au début aussi", async () => {
    const { container, rerender } = render(<PlayerOnScreen people={C} visible onPick={() => {}} maxWidth={null} />);
    const row = container.querySelector("[data-onscreen-row]")!;
    await frame();
    scrollable(row, 380);
    rerender(<PlayerOnScreen people={C} visible onPick={() => {}} maxWidth={302} />);
    expect(row.scrollLeft).toBe(0);
  });

  it("sous un doigt, ou après qu'on l'a fait défiler : rien ne saute", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container, rerender } = render(<PlayerOnScreen people={C} visible onPick={() => {}} maxWidth={null} />);
    const row = container.querySelector("[data-onscreen-row]")!;
    fireEvent.pointerDown(row);
    scrollable(row, 150);
    fireEvent.scroll(row);
    // La scène change sous le doigt : la rangée garde ce qu'elle montre, et où elle en est.
    rerender(<PlayerOnScreen people={A} visible onPick={() => {}} maxWidth={null} />);
    rerender(<PlayerOnScreen people={A} visible onPick={() => {}} maxWidth={302} />);
    expect(row.scrollLeft).toBe(150);
    fireEvent.pointerUp(row);
    // Doigt levé, même scène qu'au départ (rien à rattraper) : la place choisie reste, même si la largeur change.
    rerender(<PlayerOnScreen people={C} visible onPick={() => {}} maxWidth={280} />);
    act(() => void vi.advanceTimersByTime(ONSCREEN_SETTLE_MS + 10));
    rerender(<PlayerOnScreen people={C} visible onPick={() => {}} maxWidth={260} />);
    expect(row.scrollLeft).toBe(150);
  });
});

describe("« Jusqu'ici » préparé sur une intention seulement (10.27.2)", () => {
  function fine(matches: boolean) {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: matches && q.includes("pointer: fine"), media: q, addEventListener() {}, removeEventListener() {} }));
  }
  it("un pointeur fin posé 300 ms sur une pilule : une intention, pour cette personne seule", () => {
    vi.useFakeTimers();
    fine(true);
    const onIntent = vi.fn();
    const { container } = render(<PlayerOnScreen people={A} visible onPick={() => {}} onIntent={onIntent} />);
    const pill = container.querySelector('[data-onscreen-person="2"]')!;
    fireEvent.pointerOver(pill, { pointerType: "mouse" });
    act(() => void vi.advanceTimersByTime(SOFAR_HOVER_INTENT_MS - 50));
    expect(onIntent).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(100));
    expect(onIntent).toHaveBeenCalledTimes(1);
    expect(onIntent.mock.calls[0][0].personId).toBe(2);
  });
  it("un passage (parti avant 300 ms), un doigt, un écran sans pointeur fin : rien", () => {
    vi.useFakeTimers();
    fine(true);
    const onIntent = vi.fn();
    const { container } = render(<PlayerOnScreen people={A} visible onPick={() => {}} onIntent={onIntent} />);
    const pill = container.querySelector('[data-onscreen-person="1"]')!;
    fireEvent.pointerOver(pill, { pointerType: "mouse" });
    act(() => void vi.advanceTimersByTime(150));
    fireEvent.pointerOut(pill, { pointerType: "mouse", relatedTarget: document.body });
    act(() => void vi.advanceTimersByTime(SOFAR_HOVER_INTENT_MS));
    fireEvent.pointerOver(pill, { pointerType: "touch" });
    act(() => void vi.advanceTimersByTime(SOFAR_HOVER_INTENT_MS * 2));
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.pointerOut(pill, { pointerType: "touch", relatedTarget: document.body });
    fine(false);
    fireEvent.pointerOver(pill, { pointerType: "mouse" });
    act(() => void vi.advanceTimersByTime(SOFAR_HOVER_INTENT_MS * 2));
    expect(onIntent).not.toHaveBeenCalled();
  });
  it("prewarmSofar : une personne, une fois par coupe, jamais page cachée", () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ t: "queued" }) + "\n"));
    vi.stubGlobal("fetch", fetchMock);
    prewarmSofar("item-9", 2, 700);
    prewarmSofar("item-9", 2, 890);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({ mode: "jusquici", personId: 2, prewarm: true });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      prewarmSofar("item-9", 3, 700);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    }
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
  it("film en lecture, commandes affichées : la rangée (ouverte par son bouton), sans question dans le lecteur (13/11/2026)", async () => {
    stubFetch();
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig({ xrayAvailable: true, askAvailable: true, askPersonAvailable: true, sofarAvailable: true }, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 10, true);
    await waitFor(() => expect(container.querySelector("[data-player-onscreen]")).toBeTruthy());
    expect(container.querySelector('[data-player-nav="ask"]')).toBeNull();
    // Le bouton d'« À l'écran » : une icône seule, nommée pour les lecteurs d'écran.
    const toggle = container.querySelector<HTMLElement>('[data-player-nav="onscreen"]')!;
    expect(toggle.textContent).toBe("");
    expect(toggle.getAttribute("aria-label")).toBe("xray.onScreen");
    // La rangée part avec les commandes : dans la couche des commandes, qui porte leur état.
    expect(container.querySelector("[data-chrome]")!.contains(container.querySelector("[data-player-onscreen]"))).toBe(true);
  });

  it("personne de reconnu : le bouton d'« À l'écran » seul, sans rangée ni question", async () => {
    stubFetch();
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig({ xrayAvailable: true, askAvailable: true, askPersonAvailable: true, sofarAvailable: true }, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 60, true);
    await waitFor(() => expect(container.querySelector('[data-player-nav="onscreen"]')).toBeTruthy());
    expect(container.querySelector('[data-player-nav="ask"]')).toBeNull();
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

  it("la rangée qui paraît, en lecture comme en pause, ne prépare rien (10.27.2 : ~6 textes par heure pour zéro ou une lecture)", async () => {
    const fetchMock = stubFetch();
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig({ xrayAvailable: true, askAvailable: true, askPersonAvailable: true, sofarAvailable: true }, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 10, true);
    await waitFor(() => expect(container.querySelector("[data-onscreen-row]")).toBeTruthy());
    await at(video!, 610, false);
    await act(async () => void (await new Promise((r) => setTimeout(r, 300))));
    expect(prewarms(fetchMock)).toHaveLength(0);
  });

  it("au toucher d'une pilule, « Jusqu'ici » part avant que le panneau soit monté, et le panneau reprend cette demande", async () => {
    const order: { url: string; method: string; panel: boolean; body: string }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      order.push({ url: String(url), method: init?.method ?? "GET", panel: !!document.querySelector("[data-ask-panel]"), body: String(init?.body ?? "") });
      if (String(url).startsWith("/api/player/xray/")) return new Response(JSON.stringify(PAYLOAD));
      if (init?.method === "POST") return new Response(JSON.stringify({ t: "text", v: "Ariadne construit le labyrinthe." }) + "\n" + JSON.stringify({ t: "done" }) + "\n");
      return new Response(JSON.stringify({ available: true }));
    });
    vi.stubGlobal("fetch", fetchMock);
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig({ xrayAvailable: true, askAvailable: true, askPersonAvailable: true, sofarAvailable: true }, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 10, false);
    const pill = await waitFor(() => container.querySelector<HTMLElement>('[data-onscreen-person="2"]')!);
    const before = order.length;
    fireEvent.click(pill);
    const after = order.slice(before);
    // La première requête après le toucher : « Jusqu'ici », panneau pas encore là.
    expect(after[0]).toMatchObject({ method: "POST", panel: false });
    expect(after[0].body).toContain('"mode":"jusquici"');
    await screen.findByText("Ariadne construit le labyrinthe.");
    // Une seule demande : le panneau a repris celle du toucher.
    expect(order.filter((o) => o.method === "POST" && o.body.includes('"jusquici"'))).toHaveLength(1);
  });

  it("à une limite de tranche : la position est lue une fois au toucher — une seule demande, la même coupe (10.28.1)", async () => {
    // La personne est à l'écran de 250 à 400 s. L'heure affichée dit 299 s (coupe 0) ; la vidéo, lue un instant
    // plus tard par le panneau, 300,4 s (coupe 250 — la scène qui commence avant la marque des 300 s). En 10.28.0,
    // le toucher demandait à 299 et le panneau à 300 : deux clés, deux demandes, parfois deux générations payées.
    const boundary: XrayPlayerPayload = { status: "done", complete: true, analyzedUntil: 2000, scenes: [{ start: 0, end: 50, people: [] }, { start: 250, end: 400, people: A }] };
    const posts: { positionS: number }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/player/xray/")) return new Response(JSON.stringify(String(url).includes("person=") ? { status: "none" } : boundary));
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as { positionS: number });
        return new Response(JSON.stringify({ t: "text", v: "Ariadne dessine." }) + "\n" + JSON.stringify({ t: "done" }) + "\n");
      }
      return new Response(JSON.stringify({ available: true }));
    });
    vi.stubGlobal("fetch", fetchMock);
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig({ xrayAvailable: true, askAvailable: true, askPersonAvailable: true, sofarAvailable: true }, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 299, false);
    const pill = await waitFor(() => container.querySelector<HTMLElement>('[data-onscreen-person="2"]')!);
    // La vidéo avance sans `timeupdate` encore : l'heure affichée (299) et celle de l'élément (300,4) diffèrent.
    Object.defineProperty(video!, "currentTime", { value: 300.4, writable: true, configurable: true });
    fireEvent.click(pill);
    await screen.findByText("Ariadne dessine.");
    expect(posts).toHaveLength(1);
    expect(posts[0].positionS).toBe(300);
  });

  it("la sortie d'un compte oublie « Jusqu'ici » lu et préparé (10.28.1) : le suivant redemande", async () => {
    const fetchMock = stubFetch();
    prewarmSofar("item-9", 2, 610, null);
    prewarmSofar("item-9", 2, 610, null);
    expect(prewarms(fetchMock)).toHaveLength(1);
    const { forgetAccountOnDevice } = await import("@/lib/signOut");
    await forgetAccountOnDevice(50);
    prewarmSofar("item-9", 2, 610, null);
    expect(prewarms(fetchMock)).toHaveLength(2);
  });

  it("le lecteur ouvert, option ouverte : le contexte est préparé une fois (GET de la route des questions)", async () => {
    const fetchMock = stubFetch();
    let video: HTMLVideoElement | null = null;
    withConfig({ xrayAvailable: true, askAvailable: true, askPersonAvailable: true, sofarAvailable: true }, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 10, false);
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url, init]) => String(url) === "/api/cinema/ask/item-1" && !(init as RequestInit | undefined)?.method)).toHaveLength(1)
    );
  });

  it("au bureau, le pointeur posé sur une pilule : cette personne seule est préparée ; le clic qui suit l'ouvre", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("pointer: fine"), media: q, addEventListener() {}, removeEventListener() {} }));
    const fetchMock = stubFetch();
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig({ xrayAvailable: true, askAvailable: true, askPersonAvailable: true, sofarAvailable: true }, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 10, false);
    const pill = await waitFor(() => container.querySelector<HTMLElement>('[data-onscreen-person="2"]')!);
    fireEvent.pointerOver(pill, { pointerType: "mouse" });
    await waitFor(() => expect(prewarms(fetchMock)).toHaveLength(1));
    expect(prewarms(fetchMock)[0]).toMatchObject({ mode: "jusquici", personId: 2, prewarm: true, positionS: 10 });
    fireEvent.click(pill);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url, init]) => String(url).startsWith("/api/cinema/ask/") && /"mode":"jusquici"/.test(String(init?.body)) && !/"prewarm":true/.test(String(init?.body)))
      ).toBe(true)
    );
  });
});

describe("10.27.2 — la rangée tient les commandes pendant qu'on la touche", () => {
  it("PlayerOnScreen : `onHold` au premier contact (doigt, molette, flèche), `onRelease` à la fin du geste", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const onRelease = vi.fn();
    const { container } = render(<PlayerOnScreen people={A} visible onPick={() => {}} onHold={onHold} onRelease={onRelease} />);
    const row = container.querySelector("[data-onscreen-row]")!;
    fireEvent.touchStart(row);
    expect(onHold).toHaveBeenCalledTimes(1);
    fireEvent.scroll(row);
    act(() => void vi.advanceTimersByTime(ONSCREEN_SETTLE_MS * 3));
    expect(onRelease).not.toHaveBeenCalled();
    fireEvent.touchEnd(row);
    act(() => void vi.advanceTimersByTime(ONSCREEN_SETTLE_MS + 10));
    expect(onRelease).toHaveBeenCalledTimes(1);
    // La molette : un geste à elle seule (sur une rangée qui déborde — jsdom ne mesure rien).
    Object.defineProperty(row, "scrollWidth", { value: 900, configurable: true });
    Object.defineProperty(row, "clientWidth", { value: 300, configurable: true });
    fireEvent.wheel(row, { deltaY: 40 });
    expect(onHold).toHaveBeenCalledTimes(2);
    act(() => void vi.advanceTimersByTime(ONSCREEN_SETTLE_MS + 10));
    expect(onRelease).toHaveBeenCalledTimes(2);
  });

  it("dans le lecteur, en lecture : la rangée touchée pendant cinq secondes, les commandes restent ; relâchée, elles repartent", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch();
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig({ xrayAvailable: true, askAvailable: true, askPersonAvailable: true, sofarAvailable: true }, <Harness onVideoRef={(v) => (video = v)} />);
    await at(video!, 10, true);
    const row = await waitFor(() => container.querySelector<HTMLElement>("[data-onscreen-row]")!);
    // L'événement que les commandes écoutent pour lancer leur décompte (voir PlayerControls-masquage-barre).
    await act(async () => void video!.dispatchEvent(new Event("play")));
    fireEvent.pointerDown(row);
    await act(async () => void (await vi.advanceTimersByTimeAsync(5000)));
    expect(container.querySelector("[data-chrome]")!.getAttribute("data-chrome")).toBe("shown");
    fireEvent.pointerUp(row);
    await act(async () => void (await vi.advanceTimersByTimeAsync(ONSCREEN_SETTLE_MS + 10_000 + 200)));
    expect(container.querySelector("[data-chrome]")!.getAttribute("data-chrome")).toBe("hidden");
  });
});
