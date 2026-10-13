// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, renderHook, act, cleanup } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";

/**
 * Pendant un film, le battement de lecture tient lieu de présence et d'état de maintenance
 * (13/10/2026). Le relevé du 13/10 comptait, par heure de film, 73 `/api/presence` et 60
 * `/api/maintenance` à côté du battement, qui portait déjà l'un et l'autre. Tant qu'un battement
 * passe, les deux se taisent ; qu'il cesse, et ils reprennent d'eux-mêmes. Hors film, rien ne change.
 */

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
let playbackSession: { itemId: string; title: string } | null = null;
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ session: playbackSession }) }));

import { PresencePinger } from "@/components/PresencePinger";
import { useMaintenance, maintenanceFedByPlayback } from "@/lib/useMaintenance";
import { forgetProgressBeat, noteProgressBeat, PROGRESS_BEAT_FRESH_MS } from "@/lib/progressBeat";
import { setWatchingFullScreen } from "@/lib/playbackBusy";

let calls: string[] = [];
const count = (path: string) => calls.filter((url) => url === path).length;

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  pathname = "/";
  playbackSession = null;
  forgetProgressBeat();
  setWatchingFullScreen(false);
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ active: false, noticeAt: null, expiresAt: null }) };
  });
  // Le pinger passe par `sendBeacon` en partant ; jsdom n'en a pas.
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setWatchingFullScreen(false);
});

describe("la présence pendant un film", () => {
  it("se tait tant que le battement passe, et reprend seule quand il cesse", async () => {
    playbackSession = { itemId: "film-1", title: "Film" };
    render(<PresencePinger />);
    // L'ouverture du film : immédiate, titre compris.
    const opening = count("/api/presence");
    expect(opening).toBeGreaterThanOrEqual(1);
    // Le battement passe toutes les 30 s : la minute de présence se tait.
    for (let t = 0; t < 5 * 60_000; t += 30_000) {
      noteProgressBeat();
      await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    }
    expect(count("/api/presence")).toBe(opening);
    // Le battement cesse (lecteur arrêté sur une erreur) : la présence reprend, à la minute.
    await act(async () => void (await vi.advanceTimersByTimeAsync(PROGRESS_BEAT_FRESH_MS + 60_000)));
    expect(count("/api/presence")).toBeGreaterThan(opening);
  });

  it("le passage en arrière-plan part toujours à l'instant", async () => {
    playbackSession = { itemId: "film-1", title: "Film" };
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
    render(<PresencePinger />);
    noteProgressBeat();
    act(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(beacon).toHaveBeenCalledWith("/api/presence", expect.any(Blob));
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(beacon).toHaveBeenCalledTimes(2);
    Object.defineProperty(navigator, "sendBeacon", { value: undefined, configurable: true });
  });

  it("hors film, la minute est inchangée — même avec un battement récent", async () => {
    render(<PresencePinger />);
    noteProgressBeat();
    const first = count("/api/presence");
    await act(async () => void (await vi.advanceTimersByTimeAsync(3 * 60_000)));
    expect(count("/api/presence")).toBe(first + 3);
  });
});

describe("l'état de maintenance pendant un film", () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );

  it("vient du battement : plus aucune requête `/api/maintenance` tant qu'il passe", async () => {
    setWatchingFullScreen(true);
    noteProgressBeat();
    expect(maintenanceFedByPlayback()).toBe(true);
    renderHook(() => useMaintenance(), { wrapper });
    for (let t = 0; t < 10 * 60_000; t += 30_000) {
      noteProgressBeat();
      await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    }
    expect(count("/api/maintenance")).toBe(0);
    // Le battement cesse : le filet reprend, à la minute.
    await act(async () => void (await vi.advanceTimersByTimeAsync(PROGRESS_BEAT_FRESH_MS + 2 * 60_000)));
    expect(maintenanceFedByPlayback()).toBe(false);
    expect(count("/api/maintenance")).toBeGreaterThanOrEqual(1);
  });

  it("hors film, toutes les quinze secondes comme avant", async () => {
    noteProgressBeat();
    expect(maintenanceFedByPlayback()).toBe(false);
    renderHook(() => useMaintenance(), { wrapper });
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    // Au montage, puis toutes les 15 s.
    expect(count("/api/maintenance")).toBeGreaterThanOrEqual(4);
    expect(count("/api/maintenance")).toBeLessThanOrEqual(5);
  });
});
