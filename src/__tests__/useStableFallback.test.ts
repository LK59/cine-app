// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStableFallback, NEGOTIATING_MS } from "@/lib/useStableFallback";

// The handover itself, apart from the two players it sits between. What matters is that it
// happens without asking, says so once, and leaves an account of why.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useStableFallback", () => {
  it("cède la main sans rien demander, et retient pourquoi", () => {
    const { result } = renderHook(() => useStableFallback());
    expect(result.current.handedOver).toEqual([]);
    expect(result.current.negotiating).toBe(false);

    act(() => result.current.stepAside("film-1", "le navigateur a refusé une opération sur le tampon"));

    expect(result.current.handedOver).toEqual(["film-1"]);
    expect(result.current.negotiating).toBe(true);
    // The viewer is told nothing of this; the panel of the player taking over is.
    expect(result.current.reason).toContain("refusé une opération");
  });

  it("retire le mot tout seul, sans rien à fermer", () => {
    const { result } = renderHook(() => useStableFallback());
    act(() => result.current.stepAside("film-1", "raison"));
    expect(result.current.negotiating).toBe(true);

    act(() => void vi.advanceTimersByTime(NEGOTIATING_MS + 10));
    expect(result.current.negotiating).toBe(false);
    // The reason outlives the word: it is what the panel shows long afterwards.
    expect(result.current.reason).toBe("raison");
  });

  it("ne redit pas le mot pour un film déjà cédé", () => {
    // The failing path can report more than once on its way down. Saying it twice would
    // interrupt a player that is by then busy playing.
    const { result } = renderHook(() => useStableFallback());
    act(() => result.current.stepAside("film-1", "première raison"));
    act(() => void vi.advanceTimersByTime(NEGOTIATING_MS + 10));
    act(() => result.current.stepAside("film-1", "deuxième raison"));

    expect(result.current.negotiating).toBe(false);
    expect(result.current.reason).toBe("première raison");
    expect(result.current.handedOver).toEqual(["film-1"]);
  });

  it("ne condamne qu'un film à la fois", () => {
    // One file the experimental player cannot carry says nothing about the next, so the next
    // still gets the good path.
    const { result } = renderHook(() => useStableFallback());
    act(() => result.current.stepAside("film-1", "raison"));
    expect(result.current.handedOver).not.toContain("film-2");

    act(() => result.current.stepAside("film-2", "autre raison"));
    expect(result.current.handedOver).toEqual(["film-1", "film-2"]);
    expect(result.current.negotiating).toBe(true);
  });
});
