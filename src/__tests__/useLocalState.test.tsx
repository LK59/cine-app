// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useLocalState } from "@/hooks/useLocalState";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("useLocalState", () => {
  it("initializes from an existing localStorage value instead of the default", () => {
    localStorage.setItem("k", JSON.stringify("stored"));
    const { result } = renderHook(() => useLocalState("k", "default"));
    expect(result.current[0]).toBe("stored");
  });

  it("falls back to the default when nothing is stored yet", () => {
    const { result } = renderHook(() => useLocalState("missing-key", "default"));
    expect(result.current[0]).toBe("default");
  });

  it("falls back to the default when the stored value is corrupt JSON", () => {
    localStorage.setItem("k", "{not json");
    const { result } = renderHook(() => useLocalState("k", "default"));
    expect(result.current[0]).toBe("default");
  });

  it("persists a plain value to localStorage and updates state", () => {
    const { result } = renderHook(() => useLocalState("k", 1));
    act(() => result.current[1](5));
    expect(result.current[0]).toBe(5);
    expect(localStorage.getItem("k")).toBe("5");
  });

  it("supports a functional updater based on the previous value", () => {
    const { result } = renderHook(() => useLocalState("k", 1));
    act(() => result.current[1]((prev) => prev + 1));
    expect(result.current[0]).toBe(2);
    expect(localStorage.getItem("k")).toBe("2");
  });

  it("still updates in-memory state when localStorage.setItem throws (quota/private mode)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const { result } = renderHook(() => useLocalState("k", 1));
    act(() => result.current[1](5));
    expect(result.current[0]).toBe(5);
  });
});
