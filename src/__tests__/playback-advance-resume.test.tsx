// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";

/**
 * Le menu « Épisodes » du lecteur (19/10/2026) passe par `advance`, comme l'épisode suivant : même
 * séance, même entrée d'historique — le lecteur ne se ferme pas (le défaut du 18/10 venait d'un
 * Retour après `play()`) —, et l'épisode choisi s'ouvre à sa position. Sans position, zéro, comme avant.
 */

vi.mock("@/lib/codecSupport", () => ({ detectCodecSupport: async () => ({}) }));
vi.mock("@/lib/unsentStop", () => ({ flushOrphanStops: async () => {} }));
vi.mock("@/lib/unsentLines", () => ({ flushUnsentLines: async () => {} }));
vi.mock("@/lib/unsentPosition", () => ({ flushUnsentPositions: async () => {}, unsentPositionsPending: () => false }));
vi.mock("@/lib/catalogueOutage", () => ({ playBlockedByOutage: () => false }));

import { PlaybackProvider, usePlayback } from "@/components/PlaybackProvider";
import { usePlayerBackClose, __resetPlayerHistoryForTests } from "@/lib/playerHistory";

let api!: ReturnType<typeof usePlayback>;
const stops: string[] = [];

function FakePlayer() {
  const closed = useRef(false);
  usePlayerBackClose(() => {
    if (closed.current) return;
    closed.current = true;
    stops.push("close");
  });
  return null;
}
function Probe() {
  const playback = usePlayback();
  useEffect(() => {
    api = playback;
  });
  return playback.session ? <FakePlayer key={playback.session.openId} /> : null;
}

beforeEach(() => {
  __resetPlayerHistoryForTests();
  stops.length = 0;
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});
afterEach(() => cleanup());

describe("advance depuis le menu « Épisodes »", () => {
  it("ouvre l'épisode à sa position, dans la même séance, sans fermer le lecteur", async () => {
    render(
      <PlaybackProvider>
        <Probe />
      </PlaybackProvider>
    );
    act(() => api.play({ itemId: "e3", title: "Trois", resumeAt: 0 }));
    await waitFor(() => expect(api.session?.itemId).toBe("e3"));
    const openId = api.session?.openId;
    act(() => api.advance({ itemId: "e2", title: "Deux", resumeAt: 1800 }));
    await waitFor(() => expect(api.session?.itemId).toBe("e2"));
    expect(api.session?.resumeAt).toBe(1800);
    expect(api.session?.openId).toBe(openId);
    act(() => api.advance({ itemId: "e3", title: "Trois" }));
    await waitFor(() => expect(api.session?.itemId).toBe("e3"));
    expect(api.session?.resumeAt).toBe(0);
    await act(async () => void (await new Promise((r) => setTimeout(r, 60))));
    expect(stops).toEqual([]);
    expect(api.mode).toBe("full");
  });
});
