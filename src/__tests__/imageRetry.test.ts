// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/playbackBusy", () => ({ isWatchingFullScreen: vi.fn(() => false) }));

import { isWatchingFullScreen } from "@/lib/playbackBusy";
import {
  MAX_CONCURRENT_RETRIES,
  RETRY_DELAYS_MS,
  imageRetryStateForTests,
  reportImageFailure,
  resetImageRetryForTests,
  retryAllNow,
  setRetryRandomForTests,
  settleRetry,
  type RetryEntry,
} from "@/lib/imageRetry";

// Les images qui échouent retentent (DECISIONS.md) — le registre seul, sans composant.

function entry(extra: Partial<RetryEntry> = {}): RetryEntry & { calls: number } {
  const e = { calls: 0, retry: () => void (e.calls += 1), ...extra };
  return e;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetImageRetryForTests();
  setRetryRandomForTests(() => 0.5); // délai exact : ×1
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  vi.mocked(isWatchingFullScreen).mockReturnValue(false);
});
afterEach(() => {
  resetImageRetryForTests();
  vi.useRealTimers();
});

describe("imageRetry — l'échelle des essais", () => {
  it("réessaie à ~2 s, ~6 s, ~15 s, puis s'arrête", () => {
    const e = entry();
    reportImageFailure(e);
    vi.advanceTimersByTime(RETRY_DELAYS_MS[0] - 1);
    expect(e.calls).toBe(0);
    vi.advanceTimersByTime(1);
    expect(e.calls).toBe(1);
    settleRetry(e, false);
    vi.advanceTimersByTime(RETRY_DELAYS_MS[1]);
    expect(e.calls).toBe(2);
    settleRetry(e, false);
    vi.advanceTimersByTime(RETRY_DELAYS_MS[2]);
    expect(e.calls).toBe(3);
    settleRetry(e, false);
    vi.advanceTimersByTime(60_000);
    expect(e.calls).toBe(3);
    expect(imageRetryStateForTests().states).toEqual(["stopped"]);
  });

  it("une réussite sort l'image du registre", () => {
    const e = entry();
    reportImageFailure(e);
    vi.advanceTimersByTime(RETRY_DELAYS_MS[0]);
    settleRetry(e, true);
    expect(imageRetryStateForTests()).toMatchObject({ tracked: 0, running: 0 });
  });

  it("au retour du réseau ou de l'appli, tout ce qui est arrêté réessaie aussitôt", () => {
    const a = entry();
    const b = entry();
    for (const e of [a, b]) {
      reportImageFailure(e);
      for (const ms of RETRY_DELAYS_MS) {
        vi.advanceTimersByTime(ms);
        settleRetry(e, false);
      }
    }
    expect(a.calls).toBe(3);
    window.dispatchEvent(new Event("online"));
    expect(a.calls).toBe(4);
    expect(b.calls).toBe(4);
    settleRetry(a, false);
    settleRetry(b, false);
    // L'échelle repart du début.
    vi.advanceTimersByTime(RETRY_DELAYS_MS[0]);
    expect(a.calls).toBe(5);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    settleRetry(a, false);
    vi.advanceTimersByTime(RETRY_DELAYS_MS[1]);
    settleRetry(a, false);
    vi.advanceTimersByTime(RETRY_DELAYS_MS[2]);
    settleRetry(a, false);
    const before = a.calls;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(a.calls).toBe(before + 1);
  });

  it("hors ligne, rien n'est tenté avant le retour du réseau", () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const e = entry();
    reportImageFailure(e);
    vi.advanceTimersByTime(60_000);
    expect(e.calls).toBe(0);
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    retryAllNow();
    expect(e.calls).toBe(1);
  });

  it("au retour du réseau, pas de rafale : au plus six essais à la fois, les images visibles d'abord", () => {
    const hidden = Array.from({ length: 20 }, () => entry({ visible: false }));
    const shown = Array.from({ length: 3 }, () => entry({ visible: true }));
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    for (const e of [...hidden, ...shown]) reportImageFailure(e);
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    retryAllNow();
    const started = [...hidden, ...shown].filter((e) => e.calls > 0);
    expect(started).toHaveLength(MAX_CONCURRENT_RETRIES);
    expect(shown.every((e) => e.calls === 1)).toBe(true);
    expect(imageRetryStateForTests().running).toBe(MAX_CONCURRENT_RETRIES);
    // Un essai se termine : le suivant part.
    settleRetry(shown[0], true);
    expect([...hidden, ...shown].filter((e) => e.calls > 0)).toHaveLength(MAX_CONCURRENT_RETRIES + 1);
  });

  it("pendant un film, seules les images du lecteur réessaient", () => {
    vi.mocked(isWatchingFullScreen).mockReturnValue(true);
    const poster = entry();
    const intro = entry({ player: true });
    reportImageFailure(poster);
    reportImageFailure(intro);
    vi.advanceTimersByTime(RETRY_DELAYS_MS[0]);
    expect(intro.calls).toBe(1);
    expect(poster.calls).toBe(0);
    vi.mocked(isWatchingFullScreen).mockReturnValue(false);
    vi.advanceTimersByTime(3000);
    expect(poster.calls).toBe(1);
  });
});
