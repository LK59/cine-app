// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { PosterHoverPreview } from "@/components/PosterHoverPreview";

function stubHoverCapable(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  );
}

const previewData = {
  itemId: "a".repeat(32),
  width: 320,
  height: 180,
  tileWidth: 10,
  tileHeight: 10,
  frames: [0, 60, 120],
};

beforeEach(() => {
  vi.useFakeTimers();
  stubHoverCapable(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PosterHoverPreview", () => {
  it("renders nothing while not hovering", () => {
    const { container } = render(<PosterHoverPreview tmdbId={1} mediaType="movie" hovering={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("does not fetch before the 700ms hover-start delay elapses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => previewData });
    vi.stubGlobal("fetch", fetchMock);
    render(<PosterHoverPreview tmdbId={1} mediaType="movie" hovering />);

    act(() => vi.advanceTimersByTime(600));
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTime(150));
    expect(fetchMock).toHaveBeenCalledWith("/api/jellyfin/trickplay/preview?tmdbId=1&mediaType=movie");
  });

  it("renders a sprite frame once data arrives, and cycles frames every 500ms", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => previewData }));
    const { container } = render(<PosterHoverPreview tmdbId={1} mediaType="movie" hovering />);

    await act(async () => vi.advanceTimersByTime(700));
    expect(container.querySelector("div[style]")).toBeTruthy();

    const frame0Style = container.querySelector("div[style]")?.getAttribute("style");
    expect(frame0Style).toContain("background-image");

    await act(async () => vi.advanceTimersByTime(500));
    // Frame index advanced (from 0 to 60 in the frames array) — background-position should
    // differ now that a different sprite cell is being shown.
    const frame1Style = container.querySelector("div[style]")?.getAttribute("style");
    expect(frame1Style).not.toBe(frame0Style);
  });

  it("does not fetch at all when the device isn't hover-capable (mobile)", async () => {
    stubHoverCapable(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<PosterHoverPreview tmdbId={1} mediaType="movie" hovering />);

    await act(async () => vi.advanceTimersByTime(1000));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels the pending fetch delay when hovering ends early", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => previewData });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<PosterHoverPreview tmdbId={1} mediaType="movie" hovering />);

    act(() => vi.advanceTimersByTime(300));
    rerender(<PosterHoverPreview tmdbId={1} mediaType="movie" hovering={false} />);

    await act(async () => vi.advanceTimersByTime(1000));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not re-fetch on a second hover once the preview is already cached", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => previewData });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<PosterHoverPreview tmdbId={1} mediaType="movie" hovering />);

    await act(async () => vi.advanceTimersByTime(700));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender(<PosterHoverPreview tmdbId={1} mediaType="movie" hovering={false} />);
    rerender(<PosterHoverPreview tmdbId={1} mediaType="movie" hovering />);
    await act(async () => vi.advanceTimersByTime(700));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders nothing and stays quiet when the item has no trickplay preview (404)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const { container } = render(<PosterHoverPreview tmdbId={1} mediaType="movie" hovering />);

    await act(async () => vi.advanceTimersByTime(700));
    expect(container).toBeEmptyDOMElement();
  });
});
