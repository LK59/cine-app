// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useDelayedClose } from "@/lib/useDelayedClose";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useDelayedClose", () => {
  it("starts not closing", () => {
    const { result } = renderHook(() => useDelayedClose(vi.fn(), 200));
    expect(result.current.closing).toBe(false);
  });

  it("flips closing to true immediately on requestClose, but delays the real onClose", () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useDelayedClose(onClose, 200));

    act(() => result.current.requestClose());
    expect(result.current.closing).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(200));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose before exitMs has elapsed", () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useDelayedClose(onClose, 200));

    act(() => result.current.requestClose());
    act(() => vi.advanceTimersByTime(199));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores a repeat requestClose while already closing (no double-fire, no timer reset)", () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useDelayedClose(onClose, 200));

    act(() => result.current.requestClose());
    act(() => vi.advanceTimersByTime(100));
    act(() => result.current.requestClose()); // e.g. a second Escape press mid-fade
    act(() => vi.advanceTimersByTime(100)); // total 200ms since the FIRST call

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("fires the latest onClose if the callback identity changes mid-animation", () => {
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();
    const { result, rerender } = renderHook(({ cb }) => useDelayedClose(cb, 200), {
      initialProps: { cb: onCloseA },
    });

    act(() => result.current.requestClose());
    rerender({ cb: onCloseB });
    act(() => vi.advanceTimersByTime(200));

    expect(onCloseA).not.toHaveBeenCalled();
    expect(onCloseB).toHaveBeenCalledTimes(1);
  });

  it("clears its pending timer on unmount (no late call into an unmounted component)", () => {
    const onClose = vi.fn();
    const { result, unmount } = renderHook(() => useDelayedClose(onClose, 200));

    act(() => result.current.requestClose());
    unmount();
    act(() => vi.advanceTimersByTime(200));

    expect(onClose).not.toHaveBeenCalled();
  });
});
