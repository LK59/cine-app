// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { PlaybackProvider, usePlayback } from "@/components/PlaybackProvider";
import { isWatchingFullScreen, setWatchingFullScreen } from "@/lib/playbackBusy";

// Whether the rest of the app knows to stop polling. The page behind a full-screen player stays
// mounted, and every poll on it is a radio wake-up and a re-render nobody can see — competing
// for bandwidth with the byte ranges the film itself is reading.

beforeEach(() => setWatchingFullScreen(false));

const open = () =>
  renderHook(() => usePlayback(), {
    wrapper: ({ children }) => <PlaybackProvider>{children}</PlaybackProvider>,
  });

describe("le drapeau « on regarde en plein écran »", () => {
  it("est levé pendant une lecture plein écran et retombe à la fermeture", () => {
    const { result } = open();
    expect(isWatchingFullScreen()).toBe(false);

    act(() => result.current.play({ itemId: "film-1", title: "Un film" }));
    expect(isWatchingFullScreen()).toBe(true);

    act(() => result.current.close());
    expect(isWatchingFullScreen()).toBe(false);
  });

  it("retombe dès que le lecteur est réduit", () => {
    // Minimised, the viewer is *using* the page behind the film: freezing its live data while
    // they browse would trade one annoyance for a worse one.
    const { result } = open();
    act(() => result.current.play({ itemId: "film-1", title: "Un film" }));
    act(() => result.current.minimize());
    expect(isWatchingFullScreen()).toBe(false);

    act(() => result.current.expand());
    expect(isWatchingFullScreen()).toBe(true);
  });

  it("retombe si le lecteur disparaît sans se fermer proprement", () => {
    const { result, unmount } = open();
    act(() => result.current.play({ itemId: "film-1", title: "Un film" }));
    expect(isWatchingFullScreen()).toBe(true);
    unmount();
    expect(isWatchingFullScreen()).toBe(false);
  });
});
