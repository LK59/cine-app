// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/playbackBusy", () => ({ isWatchingFullScreen: vi.fn(() => false) }));

import {
  MAX_CONCURRENT_RETRIES,
  imageRetryStateForTests,
  reportImageFailure,
  resetImageRetryForTests,
  retryAllNow,
  setRetryRandomForTests,
  type RetryEntry,
} from "@/lib/imageRetry";

// GARDE-FOU (chasse aux défauts du 11/10/2026) — un essai « en vol » qui ne se termine jamais ne
// garde pas sa place : il est compté comme un échec au bout de `RETRY_TIMEOUT_MS`. Le défaut :
//
// `PosterImage` réessaie en remontant son `<Image>` (mode `element`), et next/image est en
// `loading="lazy"` par défaut (seules `priority`/`eager` changent cela). Une affiche hors de l'écran
// remontée ne se charge pas avant d'approcher la vue : ni `onLoad` ni `onError`, donc jamais de
// `settleRetry`. Au retour du réseau (`retryAllNow`), la file sert d'abord les images visibles, puis
// les autres : six affiches hors écran prennent les six places, et plus rien ne réessaie — pas même
// une affiche visible qui échoue ensuite. Rien ne borne la durée d'un essai.

beforeEach(() => {
  vi.useFakeTimers();
  resetImageRetryForTests();
  setRetryRandomForTests(() => 0.5);
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});
afterEach(() => {
  resetImageRetryForTests();
  vi.useRealTimers();
});

describe("imageRetry — places prises par des essais qui ne se terminent jamais", () => {
  it("une affiche visible qui échoue après six essais hors écran restés muets réessaie quand même", () => {
    // Six affiches hors écran (lazy) : leur essai ne rend jamais la main.
    const offscreen: RetryEntry[] = Array.from({ length: MAX_CONCURRENT_RETRIES }, () => ({ retry: () => {}, visible: false }));
    for (const e of offscreen) reportImageFailure(e);
    vi.advanceTimersByTime(60_000);
    retryAllNow(); // le réseau revient
    expect(imageRetryStateForTests().running).toBe(MAX_CONCURRENT_RETRIES);

    // Une affiche à l'écran échoue ensuite.
    let calls = 0;
    const visible: RetryEntry = { retry: () => void (calls += 1), visible: true };
    reportImageFailure(visible);
    vi.advanceTimersByTime(10 * 60_000);
    retryAllNow();
    // Attendu : elle réessaie (au moins une fois en dix minutes et deux retours du réseau).
    expect(calls).toBeGreaterThan(0);
  });
});
