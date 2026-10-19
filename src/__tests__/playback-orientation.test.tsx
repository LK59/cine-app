// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";
import { useEffect } from "react";

/**
 * Un film peut tourner en paysage dans la PWA Android (19/10/2026). Le manifeste demande le portrait,
 * et `unlock()` revient à l'orientation par défaut — celle du manifeste pour une app installée : le
 * film restait droit, rotation automatique ou non. Le lecteur plein écran demande donc `any`, et le
 * portrait revient à sa fermeture.
 */

vi.mock("@/lib/codecSupport", () => ({ detectCodecSupport: async () => ({}) }));
vi.mock("@/lib/unsentStop", () => ({ flushOrphanStops: async () => {} }));
vi.mock("@/lib/unsentLines", () => ({ flushUnsentLines: async () => {} }));
vi.mock("@/lib/unsentPosition", () => ({ flushUnsentPositions: async () => {}, unsentPositionsPending: () => false }));
vi.mock("@/lib/catalogueOutage", () => ({ playBlockedByOutage: () => false }));

import { PlaybackProvider, usePlayback } from "@/components/PlaybackProvider";
import { __resetPlayerHistoryForTests } from "@/lib/playerHistory";

let api!: ReturnType<typeof usePlayback>;
function Probe() {
  const playback = usePlayback();
  useEffect(() => {
    api = playback;
  });
  return null;
}

const lock = vi.fn(async (_to: string) => {});
const unlock = vi.fn();

beforeEach(() => {
  __resetPlayerHistoryForTests();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  lock.mockClear();
  unlock.mockClear();
  Object.defineProperty(screen, "orientation", { configurable: true, value: { lock, unlock, type: "portrait-primary" } });
});
afterEach(() => {
  cleanup();
});

describe("orientation pendant un film", () => {
  it("demande « any » en plein écran, jamais `unlock()`, et le portrait après", async () => {
    render(
      <PlaybackProvider>
        <Probe />
      </PlaybackProvider>
    );
    expect(lock).toHaveBeenLastCalledWith("portrait-primary");
    act(() => api.play({ itemId: "film", title: "Film", resumeAt: 0 }));
    await waitFor(() => expect(lock).toHaveBeenLastCalledWith("any"));
    act(() => api.close());
    await waitFor(() => expect(lock).toHaveBeenLastCalledWith("portrait-primary"));
    expect(unlock).not.toHaveBeenCalled();
  });
});
