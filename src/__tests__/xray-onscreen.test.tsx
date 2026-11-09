// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act, fireEvent, screen, waitFor, renderHook } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useRef, type ReactNode, type RefObject } from "react";

/**
 * « À l'écran » (DECISIONS.md §138) : la scène de l'instant cherchée sans réseau, les personnes par temps à
 * l'écran, la relecture pendant l'analyse (qui s'arrête), la rangée absente sans option ou sans personne,
 * la personne touchée qui ouvre le panneau des questions avec son en-tête — et le clavier du lecteur intact.
 */

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  useLocale: () => ({ locale: "fr" }),
}));

import { PlayerControls } from "@/components/PlayerControls";
import { characterFirstName, onScreenPeople, sceneAt, useXrayScenes, xrayNextPoll, XRAY_POLL_MS, XRAY_POLL_WINDOW_MS } from "@/lib/xray/client";
import type { XrayPlayerPayload, XrayPlayerPerson } from "@/lib/xray/scenes";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const person = (personId: number, name: string | null, character: string | null, screenTime: number, confidence = 0.9): XrayPlayerPerson => ({
  personId,
  name,
  character,
  photo: null,
  screenTime,
  confidence,
});

const PAYLOAD: XrayPlayerPayload = {
  status: "done",
  complete: true,
  analyzedUntil: 600,
  scenes: [
    { start: 0, end: 50, people: [person(1, "Leonardo DiCaprio", "Dom Cobb", 12), person(2, "Elliot Page", "Ariadne", 30), person(3, null, null, 40)] },
    { start: 50, end: 120, people: [] },
    { start: 120, end: 200, people: [person(4, "Tom Hardy", "Eames", 5)] },
  ],
};

describe("la scène de l'instant et ses personnes", () => {
  it("trouve la scène qui contient l'instant — début compris, fin exclue — et rien hors des scènes", () => {
    expect(sceneAt(PAYLOAD, 0)?.start).toBe(0);
    expect(sceneAt(PAYLOAD, 49.9)?.start).toBe(0);
    expect(sceneAt(PAYLOAD, 50)?.start).toBe(50);
    expect(sceneAt(PAYLOAD, 150)?.start).toBe(120);
    expect(sceneAt(PAYLOAD, 250)).toBeNull();
    expect(sceneAt(null, 10)).toBeNull();
  });
  it("par temps à l'écran décroissant, sans les visages sans nom, une fois chacun", () => {
    const scene = { start: 0, end: 1, people: [...PAYLOAD.scenes[0].people, person(2, "Elliot Page", "Ariadne", 1)] };
    expect(onScreenPeople(scene).map((p) => p.personId)).toEqual([2, 1]);
    expect(onScreenPeople(PAYLOAD.scenes[1])).toEqual([]);
  });
  it("le prénom du personnage pour « Qui est … ? »", () => {
    expect(characterFirstName("Dom Cobb")).toBe("Dom");
    expect(characterFirstName("Dr. Henry Jones")).toBe("Henry");
    expect(characterFirstName("Rose (jeune)")).toBe("Rose");
    expect(characterFirstName("")).toBeNull();
    expect(characterFirstName(null)).toBeNull();
  });
});

describe("la relecture pendant l'analyse", () => {
  it("une minute tant que l'analyse est en file ou en cours, vingt minutes au plus ; rien pour un état final", () => {
    expect(xrayNextPoll("queued", 0)).toBe(XRAY_POLL_MS);
    expect(xrayNextPoll("running", 5 * 60_000)).toBe(XRAY_POLL_MS);
    expect(xrayNextPoll("running", XRAY_POLL_WINDOW_MS)).toBeNull();
    for (const status of ["done", "off", "none", "failed", "stale"] as const) expect(xrayNextPoll(status, 0)).toBeNull();
  });

  it("relit chaque minute pendant l'analyse, s'arrête à « done », et attend une page cachée", async () => {
    vi.useFakeTimers();
    const answers: XrayPlayerPayload["status"][] = ["queued", "running", "done"];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ...PAYLOAD, status: answers.shift() ?? "done" })));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useXrayScenes("item-1", true));
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual(["/api/player/xray/item-1", expect.anything()]);
    expect(result.current?.status).toBe("queued");
    // Page cachée au moment de relire : rien ne part avant le retour.
    let hidden = true;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    await act(async () => void vi.advanceTimersByTime(XRAY_POLL_MS));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    hidden = false;
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => void vi.advanceTimersByTime(XRAY_POLL_MS));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current?.status).toBe("done");
    await act(async () => void vi.advanceTimersByTime(10 * XRAY_POLL_MS));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("« off » ou « none » : une seule lecture ; option coupée : aucune", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "off", complete: false, analyzedUntil: 0, scenes: [] })));
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useXrayScenes("item-1", true));
    await act(async () => void vi.advanceTimersByTime(5 * XRAY_POLL_MS));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    cleanup();
    fetchMock.mockClear();
    renderHook(() => useXrayScenes("item-1", false));
    await act(async () => void vi.advanceTimersByTime(5 * XRAY_POLL_MS));
    expect(fetchMock).not.toHaveBeenCalled();
  });
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

function withConfig(pub: Record<string, unknown>, node: ReactNode) {
  return render(<SWRConfig value={{ provider: () => new Map([["/api/config/public", { data: pub }]]) }}>{node}</SWRConfig>);
}

function stubFetch(payload: XrayPlayerPayload = PAYLOAD) {
  const fetchMock = vi.fn(async (url: string) =>
    String(url).startsWith("/api/player/xray/") ? new Response(JSON.stringify(payload)) : new Response("null", { status: 404 })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const xrayCalls = (fetchMock: ReturnType<typeof stubFetch>) => fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/player/xray/"));

async function atPosition(video: HTMLVideoElement, t: number) {
  Object.defineProperty(video, "duration", { value: 600, configurable: true });
  Object.defineProperty(video, "currentTime", { value: t, writable: true, configurable: true });
  await act(async () => void video.dispatchEvent(new Event("durationchange")));
  await act(async () => void video.dispatchEvent(new Event("timeupdate")));
}

describe("la rangée « À l'écran » du lecteur", () => {
  it("en pause : l'étiquette, les personnes de la scène par temps à l'écran, et « Une question ? » au bout", async () => {
    const fetchMock = stubFetch();
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig({ xrayAvailable: true, askAvailable: true }, <Harness onVideoRef={(v) => (video = v)} />);
    await atPosition(video!, 10);
    await waitFor(() => expect(container.querySelector("[data-player-onscreen]")).toBeTruthy());
    expect(screen.getByText("xray.onScreen")).toBeTruthy();
    const names = Array.from(container.querySelectorAll("[data-onscreen-person]")).map((el) => el.getAttribute("data-onscreen-person"));
    expect(names).toEqual(["2", "1"]);
    // Une photo absente : les initiales, jamais une image cassée.
    expect(container.querySelector('[data-onscreen-person="2"] [data-avatar-initials]')?.textContent).toBe("EP");
    // La pilule de la question est au bout, hors de ce qui défile.
    const ask = container.querySelector('[data-player-nav="ask"]')!;
    expect(container.querySelector("[data-onscreen-row]")!.contains(ask)).toBe(false);
    // Un saut en pause change la scène sans aucune requête.
    const before = xrayCalls(fetchMock).length;
    await atPosition(video!, 150);
    await waitFor(() => expect(Array.from(container.querySelectorAll("[data-onscreen-person]")).map((el) => el.getAttribute("data-onscreen-person"))).toEqual(["4"]));
    expect(xrayCalls(fetchMock).length).toBe(before);
  });

  it("une scène sans personne : pas de rangée, la pilule de la question seule", async () => {
    stubFetch();
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig({ xrayAvailable: true, askAvailable: true }, <Harness onVideoRef={(v) => (video = v)} />);
    await atPosition(video!, 60);
    await waitFor(() => expect(container.querySelector('[data-player-nav="ask"]')).toBeTruthy());
    expect(container.querySelector("[data-player-onscreen]")).toBeNull();
    expect(screen.queryByText("xray.onScreen")).toBeNull();
  });

  it("option coupée pour ce compte : ni requête ni rangée", async () => {
    const fetchMock = stubFetch();
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig({ xrayAvailable: false, askAvailable: true }, <Harness onVideoRef={(v) => (video = v)} />);
    await atPosition(video!, 10);
    await act(async () => {});
    expect(xrayCalls(fetchMock)).toHaveLength(0);
    expect(container.querySelector("[data-player-onscreen]")).toBeNull();
  });

  it("hors ligne ou au banc : ni requête ni rangée", async () => {
    const fetchMock = stubFetch();
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig({ xrayAvailable: true, askAvailable: true }, <Harness xrayable={false} onVideoRef={(v) => (video = v)} />);
    await atPosition(video!, 10);
    await act(async () => {});
    expect(xrayCalls(fetchMock)).toHaveLength(0);
    expect(container.querySelector("[data-player-onscreen]")).toBeNull();
  });

  it("une personne touchée ouvre le panneau des questions : sa photo, son nom, son personnage, « Qui est Ariadne ? »", async () => {
    stubFetch();
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig({ xrayAvailable: true, askAvailable: true }, <Harness onVideoRef={(v) => (video = v)} />);
    await atPosition(video!, 10);
    const pill = await waitFor(() => container.querySelector<HTMLElement>('[data-onscreen-person="2"]')!);
    fireEvent.click(pill);
    const dialog = await screen.findByRole("dialog");
    const header = dialog.querySelector('[data-ask-person="2"]')!;
    expect(header.textContent).toContain("Elliot Page");
    expect(header.textContent).toContain("Ariadne");
    expect(dialog.querySelector("[data-ask-person-more]")).toBeTruthy();
    expect(screen.getByText('ask.whoIs:{"name":"Ariadne"}')).toBeTruthy();
    expect(screen.queryByText("ask.chipPlayer0")).toBeNull();
  });

  it("le clavier du lecteur ne change pas : → avance de dix secondes, rangée affichée", async () => {
    stubFetch();
    let video: HTMLVideoElement | null = null;
    const { container } = withConfig({ xrayAvailable: true, askAvailable: true }, <Harness onVideoRef={(v) => (video = v)} />);
    await atPosition(video!, 10);
    await waitFor(() => expect(container.querySelector("[data-player-onscreen]")).toBeTruthy());
    await act(async () => void fireEvent.keyDown(document.body, { key: "ArrowRight", code: "ArrowRight" }));
    expect(video!.currentTime).toBeCloseTo(20, 1);
  });
});
