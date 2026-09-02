// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useCinemaRoute, cinemaNavigate, cinemaClose } from "@/lib/cinemaRoute";

beforeEach(() => {
  window.history.replaceState(null, "", "/cinema");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("cinemaRoute", () => {
  it("starts empty and reflects what the hash says", () => {
    const { result } = renderHook(() => useCinemaRoute());
    expect(result.current).toEqual({ tab: "movies", film: null, serie: null, episodes: false, search: false });

    act(() => cinemaNavigate({ film: 603 }));
    expect(window.location.hash).toBe("#film=603");
    expect(result.current.film).toBe(603);
  });

  it("keeps the layers it wasn't asked to change", () => {
    act(() => cinemaNavigate({ tab: "series" }, "replace"));
    act(() => cinemaNavigate({ serie: 12 }));
    act(() => cinemaNavigate({ episodes: true }));
    expect(window.location.hash).toBe("#tab=series&serie=12&episodes=1");
  });

  it("pushes a history entry for a screen and replaces for a filter", () => {
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");

    act(() => cinemaNavigate({ film: 1 }));
    expect(push).toHaveBeenCalledOnce();

    act(() => cinemaNavigate({ tab: "series" }, "replace"));
    expect(push).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledOnce();
  });

  it("steps back when it opened the layer itself", () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    act(() => cinemaNavigate({ film: 1 }));
    act(() => cinemaClose({ film: null }));
    expect(back).toHaveBeenCalledOnce();
  });

  it("rewrites the entry instead of leaving the app on a deep link", () => {
    // Landed straight on a title: nothing of ours behind, so stepping back would exit the app.
    window.history.replaceState(null, "", "/cinema#film=603");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});

    const { result } = renderHook(() => useCinemaRoute());
    expect(result.current.film).toBe(603);

    act(() => cinemaClose({ film: null }));
    expect(back).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
    expect(result.current.film).toBeNull();
  });

  it("ignores junk in the hash rather than opening a broken sheet", () => {
    window.history.replaceState(null, "", "/cinema#film=abc&serie=-4&tab=nope");
    const { result } = renderHook(() => useCinemaRoute());
    expect(result.current).toEqual({ tab: "movies", film: null, serie: null, episodes: false, search: false });
  });

  it("follows Back and Forward", () => {
    const { result } = renderHook(() => useCinemaRoute());
    act(() => cinemaNavigate({ film: 7 }));
    expect(result.current.film).toBe(7);

    // What the browser does on Back: the URL changes, then popstate fires.
    act(() => {
      window.history.replaceState(null, "", "/cinema");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current.film).toBeNull();
  });
});
