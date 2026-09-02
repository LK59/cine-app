// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useSwipeToDismiss } from "@/lib/useSwipeToDismiss";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function pointer(clientY: number): React.PointerEvent {
  return {
    clientY,
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    currentTarget: { setPointerCapture: vi.fn() },
  } as unknown as React.PointerEvent;
}

// window.innerHeight is 768 in jsdom, so the distance threshold is 768 * 0.22 ≈ 169, capped at 160.
const THRESHOLD = 160;

describe("useSwipeToDismiss", () => {
  it("tracks the finger one-to-one and can be dragged back up", () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeToDismiss(onDismiss));

    act(() => result.current.handlers.onPointerDown(pointer(100)));
    expect(result.current.dragging).toBe(true);

    act(() => result.current.handlers.onPointerMove(pointer(180)));
    expect(result.current.offset).toBe(80);

    act(() => result.current.handlers.onPointerMove(pointer(130)));
    expect(result.current.offset).toBe(30);
  });

  it("never goes above its starting position", () => {
    const { result } = renderHook(() => useSwipeToDismiss(vi.fn()));
    act(() => result.current.handlers.onPointerDown(pointer(200)));
    act(() => result.current.handlers.onPointerMove(pointer(50)));
    expect(result.current.offset).toBe(0);
  });

  it("springs back when released short of the threshold", () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeToDismiss(onDismiss));

    act(() => result.current.handlers.onPointerDown(pointer(0)));
    act(() => result.current.handlers.onPointerMove(pointer(THRESHOLD - 40)));
    // Slow enough not to count as a flick.
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 2000);
    act(() => result.current.handlers.onPointerUp(pointer(THRESHOLD - 40)));

    expect(onDismiss).not.toHaveBeenCalled();
    expect(result.current.offset).toBe(0);
    expect(result.current.dragging).toBe(false);
  });

  it("dismisses when dragged past the threshold", () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeToDismiss(onDismiss));

    act(() => result.current.handlers.onPointerDown(pointer(0)));
    act(() => result.current.handlers.onPointerMove(pointer(THRESHOLD + 20)));
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 2000);
    act(() => result.current.handlers.onPointerUp(pointer(THRESHOLD + 20)));

    expect(onDismiss).toHaveBeenCalledOnce();
    // Continues off the bottom rather than snapping back first.
    expect(result.current.offset).toBe(window.innerHeight);
  });

  it("dismisses on a short but fast flick", () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeToDismiss(onDismiss));

    act(() => result.current.handlers.onPointerDown(pointer(0)));
    act(() => result.current.handlers.onPointerMove(pointer(60)));
    act(() => result.current.handlers.onPointerUp(pointer(60)));

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("ignores a move that never started with a press", () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeToDismiss(onDismiss));

    act(() => result.current.handlers.onPointerMove(pointer(300)));
    act(() => result.current.handlers.onPointerUp(pointer(300)));

    expect(result.current.offset).toBe(0);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
