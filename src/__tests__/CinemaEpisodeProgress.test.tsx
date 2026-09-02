// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { CinemaEpisodeProgress } from "@/components/cinema/CinemaEpisodeProgress";

afterEach(cleanup);

const HOUR = 36_000_000_000; // ticks

function bar(props: { resumeTicks: number | null; runtimeTicks: number | null; watched: boolean }) {
  const { container } = render(<CinemaEpisodeProgress {...props} />);
  // The track is the component's root; the fill is its only child and carries the width.
  return (container.firstElementChild?.firstElementChild as HTMLElement | null) ?? null;
}

describe("CinemaEpisodeProgress", () => {
  it("shows how far in you are", () => {
    expect(bar({ resumeTicks: HOUR / 2, runtimeTicks: HOUR, watched: false })?.style.width).toBe("50%");
  });

  it("never renders a full bar on an unfinished episode", () => {
    // 99.8% would round to a bar that reads as "finished", which is the one thing it isn't.
    expect(bar({ resumeTicks: HOUR * 0.998, runtimeTicks: HOUR, watched: false })?.style.width).toBe("99%");
  });

  it("stays visible at the very start", () => {
    expect(bar({ resumeTicks: 1000, runtimeTicks: HOUR, watched: false })?.style.width).toBe("2%");
  });

  it("shows nothing for an untouched, a finished or an unmeasurable episode", () => {
    expect(bar({ resumeTicks: null, runtimeTicks: HOUR, watched: false })).toBeNull();
    expect(bar({ resumeTicks: HOUR / 2, runtimeTicks: HOUR, watched: true })).toBeNull();
    expect(bar({ resumeTicks: HOUR / 2, runtimeTicks: null, watched: false })).toBeNull();
    expect(bar({ resumeTicks: HOUR / 2, runtimeTicks: 0, watched: false })).toBeNull();
  });
});
