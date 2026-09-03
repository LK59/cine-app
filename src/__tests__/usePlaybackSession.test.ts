// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePlaybackSession } from "@/lib/usePlaybackSession";
import { PLAYBACK_CLIENTS } from "@/lib/playbackClients";

// What Jellyfin is told while a film plays, and — the part that actually decides whether a
// resume point is right — what it is told at the moment the film stops.

const TICKS = 10_000_000;
let posted: { path: string; body: Record<string, unknown> }[] = [];

function hidden(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

const session = { itemId: "film-1", playSessionId: "s-1", mediaSourceId: "m-1" };
const bodies = (path: string) => posted.filter((p) => p.path.endsWith(path)).map((p) => p.body);

beforeEach(() => {
  posted = [];
  vi.useFakeTimers();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    posted.push({ path: String(url), body: JSON.parse(String(init.body)) });
    return { ok: true };
  });
  hidden("visible");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("usePlaybackSession", () => {
  it("bat toutes les dix secondes, à la position que le lecteur donne", () => {
    let at = 0;
    renderHook(() => usePlaybackSession(() => at, session));
    expect(bodies("progress")).toHaveLength(0);

    at = 42;
    act(() => void vi.advanceTimersByTime(10_000));
    expect(bodies("progress")[0]).toMatchObject({ itemId: "film-1", positionTicks: 42 * TICKS });

    at = 84;
    act(() => void vi.advanceTimersByTime(10_000));
    expect(bodies("progress")[1].positionTicks).toBe(84 * TICKS);
  });

  it("annonce le démarrage quand le lecteur n'a personne d'autre pour le faire", () => {
    // The stable player's start is announced by the negotiation of its stream; the experimental
    // one negotiates nothing, so without this it reported against a session Jellyfin never knew.
    renderHook(() => usePlaybackSession(() => 0, { ...session, announce: true, client: PLAYBACK_CLIENTS.engine }));
    expect(bodies("playing")).toHaveLength(1);
    expect(bodies("playing")[0].client).toBe("CineEngine By CineApp");
  });

  it("ne l'annonce pas deux fois pour le lecteur qui l'a déjà fait", () => {
    renderHook(() => usePlaybackSession(() => 0, session));
    expect(bodies("playing")).toHaveLength(0);
  });

  it("dit la position finale en quittant", () => {
    let at = 0;
    const { unmount } = renderHook(() => usePlaybackSession(() => at, session));
    at = 1200;
    act(() => unmount());
    expect(bodies("stop")).toEqual([expect.objectContaining({ positionTicks: 1200 * TICKS })]);
  });

  it("la dit aussi sur pagehide, qui est le seul événement qu'un iPhone envoie", () => {
    // iOS never fires beforeunload: closing a tab, swiping the app away or following a link out
    // all end at pagehide instead, and without it the final position was simply lost on a phone.
    let at = 0;
    renderHook(() => usePlaybackSession(() => at, session));
    at = 600;
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(bodies("stop")).toEqual([expect.objectContaining({ positionTicks: 600 * TICKS })]);
  });

  it("ne dit la fin qu'une seule fois, quel que soit le nombre d'événements", () => {
    // beforeunload and pagehide both fire on a desktop browser, and the unmount follows.
    const { unmount } = renderHook(() => usePlaybackSession(() => 300, session));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
      window.dispatchEvent(new Event("beforeunload"));
    });
    act(() => unmount());
    expect(bodies("stop")).toHaveLength(1);
  });

  it("enregistre la position en passant en arrière-plan, sans arrêter la lecture", () => {
    // Putting an app in the background is not closing a film. Reporting a stop here would end
    // the session every time the phone locks; reporting nothing loses the position if it never
    // comes back.
    let at = 0;
    renderHook(() => usePlaybackSession(() => at, session));
    at = 900;
    act(() => hidden("hidden"));

    expect(bodies("stop")).toHaveLength(0);
    expect(bodies("progress")).toEqual([expect.objectContaining({ positionTicks: 900 * TICKS })]);
  });

  it("dit honnêtement que la lecture est en pause", () => {
    // A paused film left on screen for an hour is not an hour of watching.
    let paused = false;
    renderHook(() => usePlaybackSession(() => 10, session, () => paused));
    act(() => void vi.advanceTimersByTime(10_000));
    expect(bodies("progress")[0].isPaused).toBe(false);

    paused = true;
    act(() => void vi.advanceTimersByTime(10_000));
    expect(bodies("progress")[1].isPaused).toBe(true);
  });

  it("porte le nom du lecteur qui joue vraiment", () => {
    renderHook(() => usePlaybackSession(() => 0, { ...session, client: PLAYBACK_CLIENTS.engine }));
    act(() => void vi.advanceTimersByTime(10_000));
    expect(bodies("progress")[0].client).toBe("CineEngine By CineApp");
  });

  it("se tait tant qu'il n'y a rien à raconter", () => {
    const { unmount } = renderHook(() => usePlaybackSession(() => 0, null));
    act(() => void vi.advanceTimersByTime(60_000));
    act(() => unmount());
    expect(posted).toHaveLength(0);
  });

  it("laisse le lecteur clore lui-même, à la seconde où le spectateur ferme", () => {
    // Captured at the click rather than whenever React gets round to unmounting, which lags
    // behind the close transition.
    let at = 55;
    const { result, unmount } = renderHook(() => usePlaybackSession(() => at, session));
    act(() => result.current());
    expect(bodies("stop")).toEqual([expect.objectContaining({ positionTicks: 55 * TICKS })]);

    at = 999;
    act(() => unmount());
    expect(bodies("stop")).toHaveLength(1);
  });
});
