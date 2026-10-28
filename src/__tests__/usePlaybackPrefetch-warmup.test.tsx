// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

/**
 * La fiche prépare l'en-tête du fichier (`sheetHeaderWarmup`) seulement quand aucun film n'est
 * ouvert, l'arrête dès qu'un film s'ouvre — et ce va-et-vient ne redemande jamais l'état du
 * spectateur, qui serait lu avant que l'arrêt du film n'ait écrit sa nouvelle position.
 */

const h = vi.hoisted(() => ({
  mode: "closed" as "closed" | "full" | "mini",
  cancel: vi.fn(),
  schedule: vi.fn(),
  prefetchState: vi.fn(),
}));
vi.mock("@/components/PlaybackProvider", () => ({ usePlaybackMode: () => h.mode }));
vi.mock("@/lib/sheetHeaderWarmup", () => ({ scheduleSheetHeaderWarmup: (id: string) => h.schedule(id) }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerEnabled: () => true }));
vi.mock("@/lib/playbackPrefetch", () => ({ prefetchPlaybackState: (id: string) => h.prefetchState(id) }));
vi.mock("@/lib/directInfo", () => ({ fetchDirectInfo: () => new Promise(() => {}) }));

import { usePlaybackPrefetch } from "@/lib/usePlaybackPrefetch";

function Sheet({ id }: { id: string | null }) {
  usePlaybackPrefetch(id);
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.mode = "closed";
  h.schedule.mockImplementation(() => h.cancel);
});
afterEach(() => cleanup());

describe("l'en-tête préparé par la fiche, face au lecteur", () => {
  it("prépare le titre du bouton principal quand aucun film n'est ouvert, et arrête à la fermeture", () => {
    const { unmount } = render(<Sheet id="film" />);
    expect(h.schedule).toHaveBeenCalledWith("film");
    unmount();
    expect(h.cancel).toHaveBeenCalledTimes(1);
  });

  it("rien pendant un film, plein écran ou réduit", () => {
    h.mode = "mini";
    render(<Sheet id="film" />);
    expect(h.schedule).not.toHaveBeenCalled();
  });

  it("un film qui s'ouvre arrête la préparation ; sa fermeture la relance sans redemander la position", () => {
    const { rerender } = render(<Sheet id="film" />);
    expect(h.prefetchState).toHaveBeenCalledTimes(1);
    h.mode = "full";
    rerender(<Sheet id="film" />);
    expect(h.cancel).toHaveBeenCalledTimes(1);
    h.mode = "closed";
    rerender(<Sheet id="film" />);
    expect(h.schedule).toHaveBeenCalledTimes(2);
    expect(h.prefetchState).toHaveBeenCalledTimes(1);
  });
});
