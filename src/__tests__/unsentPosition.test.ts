// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// C — la position de reprise pendant une coupure (DECISIONS.md §78) : gardée sur l'appareil quand
// Jellyfin ne la reçoit pas, effacée dès qu'un rapport plus récent passe, renvoyée au retour du réseau
// ou au lancement suivant par la route d'arrêt marquée `late`.

vi.mock("@/lib/persistentCache", () => ({ persistedCacheAccount: () => "louis" }));

import { usePlaybackSession } from "@/lib/usePlaybackSession";
import { findUnsentPositions, flushUnsentPositions, saveUnsentPosition } from "@/lib/unsentPosition";

const session = { itemId: "film-1", playSessionId: "s-1", mediaSourceId: "m-1" };
let online = true;
let posted: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  localStorage.clear();
  posted = [];
  online = true;
  vi.useFakeTimers();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (!online) throw new TypeError("Failed to fetch");
    posted.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return { ok: true, status: 200, json: async () => ({}) };
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => void (await Promise.resolve()));
};

describe("la position d'une coupure", () => {
  it("un battement qui ne passe pas garde la position sur l'appareil ; le suivant qui passe l'efface", async () => {
    let at = 0;
    renderHook(() => usePlaybackSession(() => at, session));
    online = false;
    at = 1200;
    await act(async () => void vi.advanceTimersByTime(10_000));
    await settle();
    expect(findUnsentPositions()).toEqual([expect.objectContaining({ itemId: "film-1", seconds: 1200 })]);
    online = true;
    at = 1210;
    await act(async () => void vi.advanceTimersByTime(10_000));
    await settle();
    expect(findUnsentPositions()).toEqual([]);
  });

  it("fermé pendant la coupure : l'arrêt ne passe pas, la position reste, et part au lancement suivant (`late`)", async () => {
    let at = 0;
    const { result, unmount } = renderHook(() => usePlaybackSession(() => at, session));
    online = false;
    at = 2421;
    await act(async () => void (await result.current.stop()));
    unmount();
    await settle();
    expect(findUnsentPositions()).toEqual([expect.objectContaining({ seconds: 2421 })]);
    // Le réseau revient ; le lancement suivant (PlaybackProvider) envoie ce qui attend.
    online = true;
    await act(async () => void vi.advanceTimersByTime(30_000));
    await flushUnsentPositions();
    const late = posted.find((p) => p.url === "/api/jellyfin/playback/stop" && p.body.late === true);
    expect(late?.body).toMatchObject({ itemId: "film-1", positionTicks: 2421 * 10_000_000, late: true });
    expect(late!.body.lateByMs as number).toBeGreaterThanOrEqual(30_000);
    expect(findUnsentPositions()).toEqual([]);
  });

  it("un serveur qui redémarre (5xx) garde la position pour plus tard", async () => {
    saveUnsentPosition("film-2", 600);
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 503 }));
    await flushUnsentPositions();
    expect(findUnsentPositions()).toEqual([expect.objectContaining({ itemId: "film-2" })]);
  });

  it("rien à garder pour une position nulle", () => {
    saveUnsentPosition("film-3", 0);
    expect(findUnsentPositions()).toEqual([]);
  });
});
