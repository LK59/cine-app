// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { useEffect } from "react";

/**
 * Toute l'app tourne (19/10/2026). Le manifeste demandait le portrait, et Android l'appliquait aux
 * films aussi — `unlock()` y revient à l'orientation du manifeste, le film restait droit. Plus de
 * portrait nulle part : le manifeste n'en demande plus, rien ne le verrouille, et une PWA installée
 * avec l'ancien manifeste reçoit `lock("any")` au démarrage.
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

describe("orientation", () => {
  it("le manifeste ne demande aucune orientation", () => {
    const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8")) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty("orientation");
  });

  it("« any » au démarrage, et jamais de portrait ni d'`unlock()`, film ou pas", async () => {
    render(
      <PlaybackProvider>
        <Probe />
      </PlaybackProvider>
    );
    expect(lock.mock.calls).toEqual([["any"]]);
    act(() => api.play({ itemId: "film", title: "Film", resumeAt: 0 }));
    await waitFor(() => expect(api.session?.itemId).toBe("film"));
    act(() => api.close());
    await waitFor(() => expect(api.session).toBeNull());
    expect(lock.mock.calls).toEqual([["any"]]);
    expect(unlock).not.toHaveBeenCalled();
  });
});
