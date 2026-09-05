// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useExitDelay } from "@/lib/useExitDelay";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useExitDelay", () => {
  it("renders nothing while inactive", () => {
    const { result } = renderHook(() => useExitDelay(false, 200));
    expect(result.current).toEqual({ render: false, leaving: false });
  });

  // Le cœur : l'adresse change avant l'écran, et sans ce sursis il disparaissait d'un coup alors
  // qu'il était arrivé en glissant.
  it("keeps rendering through the exit, then stops", () => {
    const { result, rerender } = renderHook(({ on }) => useExitDelay(on, 200), {
      initialProps: { on: true },
    });
    expect(result.current).toEqual({ render: true, leaving: false });

    rerender({ on: false });
    expect(result.current).toEqual({ render: true, leaving: true });

    act(() => void vi.advanceTimersByTime(199));
    expect(result.current.render).toBe(true);

    act(() => void vi.advanceTimersByTime(2));
    expect(result.current).toEqual({ render: false, leaving: false });
  });

  // Rouvrir pendant la sortie doit reprendre la main tout de suite : sinon l'écran finissait de
  // s'en aller alors qu'on venait de le redemander.
  it("cancels the exit when it comes back mid-animation", () => {
    const { result, rerender } = renderHook(({ on }) => useExitDelay(on, 200), {
      initialProps: { on: true },
    });
    rerender({ on: false });
    act(() => void vi.advanceTimersByTime(100));
    rerender({ on: true });
    expect(result.current).toEqual({ render: true, leaving: false });

    act(() => void vi.advanceTimersByTime(500));
    expect(result.current).toEqual({ render: true, leaving: false });
  });
});
