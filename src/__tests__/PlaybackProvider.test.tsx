// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  PlaybackProvider,
  usePlayback,
  PLAYER_RELOAD_INTENT_KEY,
} from "@/components/PlaybackProvider";

function wrapper({ children }: { children: ReactNode }) {
  return <PlaybackProvider>{children}</PlaybackProvider>;
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe("PlaybackProvider / usePlayback", () => {
  it("starts closed, with no session", () => {
    const { result } = renderHook(() => usePlayback(), { wrapper });
    expect(result.current.mode).toBe("closed");
    expect(result.current.session).toBeNull();
  });

  it("play() opens the session in full mode", () => {
    const { result } = renderHook(() => usePlayback(), { wrapper });

    act(() => result.current.play({ itemId: "1", title: "Movie A" }));

    expect(result.current.mode).toBe("full");
    expect(result.current.session).toEqual({ itemId: "1", title: "Movie A" });
  });

  it("minimize()/expand() switch mode without touching the session", () => {
    const { result } = renderHook(() => usePlayback(), { wrapper });
    act(() => result.current.play({ itemId: "1", title: "Movie A", resumeAt: 42 }));

    act(() => result.current.minimize());
    expect(result.current.mode).toBe("mini");
    expect(result.current.session?.itemId).toBe("1");

    act(() => result.current.expand());
    expect(result.current.mode).toBe("full");
    expect(result.current.session?.itemId).toBe("1");
  });

  it("close() clears both the mode and the session", () => {
    const { result } = renderHook(() => usePlayback(), { wrapper });
    act(() => result.current.play({ itemId: "1", title: "Movie A" }));

    act(() => result.current.close());

    expect(result.current.mode).toBe("closed");
    expect(result.current.session).toBeNull();
  });

  it("advance() swaps to the next episode, resets resumeAt, and preserves other session fields", () => {
    const { result } = renderHook(() => usePlayback(), { wrapper });
    const getNextEpisode = () => null;
    act(() =>
      result.current.play({ itemId: "ep1", title: "Episode 1", resumeAt: 120, getNextEpisode })
    );

    act(() => result.current.advance({ itemId: "ep2", title: "Episode 2" }));

    expect(result.current.session?.itemId).toBe("ep2");
    expect(result.current.session?.title).toBe("Episode 2");
    expect(result.current.session?.resumeAt).toBeUndefined();
    expect(result.current.session?.getNextEpisode).toBe(getNextEpisode);
  });

  it("advance() is a no-op when there is no active session", () => {
    const { result } = renderHook(() => usePlayback(), { wrapper });

    act(() => result.current.advance({ itemId: "ep2", title: "Episode 2" }));

    expect(result.current.session).toBeNull();
  });

  it("usePlayback() throws outside a PlaybackProvider", () => {
    expect(() => renderHook(() => usePlayback())).toThrow(
      "usePlayback must be used within a PlaybackProvider"
    );
  });

  it("resumes a pending WebKit reload intent found in sessionStorage on mount, then clears it", () => {
    sessionStorage.setItem(
      PLAYER_RELOAD_INTENT_KEY,
      JSON.stringify({ itemId: "ep3", title: "Episode 3", audioStreamIndex: 2, resumeAt: 30, attempt: 1 })
    );

    const { result } = renderHook(() => usePlayback(), { wrapper });

    expect(result.current.mode).toBe("full");
    expect(result.current.session).toMatchObject({
      itemId: "ep3",
      title: "Episode 3",
      resumeAt: 30,
      initialAudioStreamIndex: 2,
      fromReload: true,
      reloadAttempt: 1,
    });
    expect(sessionStorage.getItem(PLAYER_RELOAD_INTENT_KEY)).toBeNull();
  });

  it("ignores a malformed reload intent instead of crashing", () => {
    sessionStorage.setItem(PLAYER_RELOAD_INTENT_KEY, "{not json");

    const { result } = renderHook(() => usePlayback(), { wrapper });

    expect(result.current.mode).toBe("closed");
    expect(result.current.session).toBeNull();
  });
});
