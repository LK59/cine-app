// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useLongPress } from "@/hooks/useLongPress";

vi.mock("@/lib/haptic", () => ({ haptic: vi.fn() }));
import { haptic } from "@/lib/haptic";

function mouseEvent(): React.MouseEvent {
  return { preventDefault: vi.fn() } as unknown as React.MouseEvent;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useLongPress", () => {
  it("fires onLongPress and haptic after the delay when the touch doesn't move", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress, 480));

    act(() => result.current.onTouchStart());
    act(() => vi.advanceTimersByTime(480));

    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(haptic).toHaveBeenCalledWith(30);
  });

  it("does not fire if touchend happens before the delay", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress, 480));

    act(() => result.current.onTouchStart());
    act(() => vi.advanceTimersByTime(200));
    act(() => result.current.onTouchEnd());
    act(() => vi.advanceTimersByTime(1000));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancels the press once the touch moves, even if held past the delay", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress, 480));

    act(() => result.current.onTouchStart());
    act(() => result.current.onTouchMove());
    act(() => vi.advanceTimersByTime(480));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("prevents the click's default navigation only right after a long press fired", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress, 480));

    act(() => result.current.onTouchStart());
    act(() => vi.advanceTimersByTime(480));

    const e1 = mouseEvent();
    act(() => result.current.onClick(e1));
    expect(e1.preventDefault).toHaveBeenCalled();

    // The fired flag is consumed by the first click — a second, unrelated click passes through.
    const e2 = mouseEvent();
    act(() => result.current.onClick(e2));
    expect(e2.preventDefault).not.toHaveBeenCalled();
  });

  it("does not prevent a plain click's default when no long press ever fired", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress, 480));

    const e = mouseEvent();
    act(() => result.current.onClick(e));
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("right-click (context menu) fires onLongPress immediately, bypassing the delay", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress, 480));

    const e = mouseEvent();
    act(() => result.current.onContextMenu(e));

    expect(e.preventDefault).toHaveBeenCalled();
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(haptic).toHaveBeenCalledWith(30);
  });
});
