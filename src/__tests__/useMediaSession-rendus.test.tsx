// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useMediaSession, type MediaSessionInfo } from "@/lib/useMediaSession";

// PlayerControls rend quatre fois par seconde (timeupdate) et passe au hook un littéral d'objet
// et des flèches neufs à chaque rendu. Le hook en dépendait : à chaque rendu, six
// setActionHandler(null), metadata = null, un nouveau MediaMetadata et six enregistrements —
// 21 écritures de metadata et 105 setActionHandler pour dix rendus où seule la position bougeait.

let metadataWrites = 0;
let handlerSets = 0;
const handlers = new Map<string, (d?: unknown) => void>();

beforeEach(() => {
  metadataWrites = 0;
  handlerSets = 0;
  handlers.clear();
  vi.stubGlobal("MediaMetadata", class { constructor(public readonly init: unknown) {} });
  Object.defineProperty(navigator, "mediaSession", {
    configurable: true,
    value: {
      set metadata(_v: unknown) {
        metadataWrites += 1;
      },
      get metadata() {
        return null;
      },
      playbackState: "none",
      setActionHandler: (a: string, h: ((d?: unknown) => void) | null) => {
        handlerSets += 1;
        if (h) handlers.set(a, h);
        else handlers.delete(a);
      },
      setPositionState: () => {},
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

// La forme exacte de l'appel dans PlayerControls : tout est recréé à chaque rendu.
function controlsLike(position: number, over: Partial<MediaSessionInfo> = {}): MediaSessionInfo {
  return {
    title: "Ted Lasso — S01E01 · Pilote",
    artworkUrl: "/api/jellyfin/image?itemId=abc",
    duration: 1800,
    position,
    playing: true,
    onPlay: () => {},
    onPause: () => {},
    onSeek: () => {},
    onSkip: () => {},
    onNext: null,
    ...over,
  };
}

describe("useMediaSession — rendus de position", () => {
  it("dix rendus où seule la position change : une écriture de metadata, un jeu d'enregistrements", () => {
    const { rerender } = renderHook(({ at }) => useMediaSession(controlsLike(at)), { initialProps: { at: 0 } });
    for (let i = 1; i <= 10; i++) rerender({ at: i * 0.25 });
    expect(metadataWrites).toBe(1);
    expect(handlerSets).toBe(5);
  });

  it("les boutons du système appellent le callback le plus récent", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(({ onPlay }) => useMediaSession(controlsLike(1, { onPlay })), {
      initialProps: { onPlay: first },
    });
    rerender({ onPlay: second });
    handlers.get("play")!();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();

    // Les autres boutons aussi, arguments compris.
    const seek = vi.fn();
    const skip = vi.fn();
    unmount();
    const { rerender: again } = renderHook(({ s, k }) => useMediaSession(controlsLike(2, { onSeek: s, onSkip: k })), {
      initialProps: { s: vi.fn(), k: vi.fn() },
    });
    again({ s: seek, k: skip });
    handlers.get("seekto")!({ seekTime: 900 });
    handlers.get("seekbackward")!({});
    expect(seek).toHaveBeenCalledWith(900);
    expect(skip).toHaveBeenCalledWith(-10);
  });

  it("un vrai changement de titre ou l'arrivée d'un épisode suivant réenregistre", () => {
    const { rerender } = renderHook(({ data }) => useMediaSession(data), { initialProps: { data: controlsLike(0) } });
    rerender({ data: controlsLike(1, { title: "Ted Lasso — S01E02 · Biscuits" }) });
    expect(metadataWrites).toBe(3); // montage, effacement, nouveau titre
    const next = vi.fn();
    rerender({ data: controlsLike(2, { title: "Ted Lasso — S01E02 · Biscuits", onNext: next }) });
    handlers.get("nexttrack")!();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
