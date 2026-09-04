// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useMediaSession, type MediaSessionInfo } from "@/lib/useMediaSession";

// What the lock screen, the Dynamic Island and a pair of headphones are told. Nothing was, and a
// media element playing sound takes the system's Now Playing slot anyway — carrying whatever the
// last web app to set one had left in it.

const handlers = new Map<string, unknown>();
let metadata: unknown = null;
let position: unknown = null;

beforeEach(() => {
  handlers.clear();
  metadata = null;
  position = null;
  vi.stubGlobal("MediaMetadata", class { constructor(public readonly init: unknown) {} });
  Object.defineProperty(navigator, "mediaSession", {
    configurable: true,
    value: {
      set metadata(v: unknown) {
        metadata = v;
      },
      get metadata() {
        return metadata;
      },
      playbackState: "none",
      setActionHandler: (a: string, h: unknown) => (h ? handlers.set(a, h) : handlers.delete(a)),
      setPositionState: (p: unknown) => (position = p),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const info = (over: Partial<MediaSessionInfo> = {}): MediaSessionInfo => ({
  title: "Ted Lasso — S01E01 · Le pilote",
  artworkUrl: "/api/jellyfin/image?itemId=abc",
  duration: 1855,
  position: 42,
  playing: true,
  onPlay: vi.fn(),
  onPause: vi.fn(),
  onSeek: vi.fn(),
  onSkip: vi.fn(),
  onNext: null,
  ...over,
});

describe("useMediaSession", () => {
  it("donne l'épisode comme titre et la série comme album", () => {
    // The one string the player shows, split the way a system expects two lines.
    renderHook(() => useMediaSession(info()));
    expect((metadata as { init: Record<string, string> }).init).toMatchObject({
      title: "S01E01 · Le pilote",
      album: "Ted Lasso",
    });
  });

  it("prend les boutons du système, et les rend en partant", () => {
    const data = info();
    const { unmount } = renderHook(() => useMediaSession(data));
    expect([...handlers.keys()]).toEqual(expect.arrayContaining(["play", "pause", "seekbackward", "seekforward", "seekto"]));

    (handlers.get("pause") as () => void)();
    expect(data.onPause).toHaveBeenCalled();
    (handlers.get("seekto") as (d: { seekTime: number }) => void)({ seekTime: 900 });
    expect(data.onSeek).toHaveBeenCalledWith(900);
    (handlers.get("seekforward") as (d: Record<string, never>) => void)({});
    expect(data.onSkip).toHaveBeenCalledWith(10);

    // A handler left behind belongs to a film that is no longer playing.
    unmount();
    expect(handlers.size).toBe(0);
    expect(metadata).toBeNull();
  });

  it("n'offre l'épisode suivant que lorsqu'il y en a un", () => {
    const { rerender } = renderHook(({ data }) => useMediaSession(data), { initialProps: { data: info() } });
    expect(handlers.has("nexttrack")).toBe(false);

    rerender({ data: info({ onNext: vi.fn() }) });
    expect(handlers.has("nexttrack")).toBe(true);
  });

  it("tient la position à jour pour la barre du système", () => {
    renderHook(() => useMediaSession(info()));
    expect(position).toMatchObject({ duration: 1855, position: 42 });
  });

  it("ne réclame rien quand il n'y a rien à montrer", () => {
    renderHook(() => useMediaSession(null));
    expect(metadata).toBeNull();
    expect(handlers.size).toBe(0);
  });
});
