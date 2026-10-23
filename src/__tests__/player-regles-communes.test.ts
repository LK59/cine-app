// @vitest-environment jsdom
// Les règles du lecteur écrites une seule fois après la fusion des doublons (DECISIONS.md §115) :
// ce que chaque module commun rend, à l'identique de ce que ses copies écrivaient.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { rebuildLine } from "@/components/player/nativeHostHelpers";
import { useWatchedClockRun } from "@/components/player/session/useWatchedClockRun";
import { WatchedClock } from "@/lib/playerSessionTally";

afterEach(() => {
  vi.useRealTimers();
});

describe("rebuildLine (§115, ligne rebuild)", () => {
  it("écrit le fichier, puis path, reason, at, puis les ajouts, dans cet ordre", () => {
    const line = rebuildLine({ file: "a.mkv", size: 3 }, "source perdue", 12, { attempt: 2, skipped: false });
    expect(Object.keys(line)).toEqual(["file", "size", "path", "reason", "at", "attempt", "skipped"]);
    expect(line).toEqual({ file: "a.mkv", size: 3, path: "remux", reason: "source perdue", at: 12, attempt: 2, skipped: false });
  });

  it("sans ajout, s'arrête à at", () => {
    expect(Object.keys(rebuildLine({}, "x", 0))).toEqual(["path", "reason", "at"]);
  });
});

describe("useWatchedClockRun (§115, horloge du temps regardé)", () => {
  it("compte tant que ça joue, s'arrête à la pause et au démontage", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const clock = new WatchedClock();
    const run = vi.spyOn(clock, "run");
    const halt = vi.spyOn(clock, "halt");
    const { rerender, unmount } = renderHook(({ playing }) => useWatchedClockRun(clock, playing), { initialProps: { playing: false } });
    expect(run).not.toHaveBeenCalled();
    rerender({ playing: true });
    expect(run).toHaveBeenCalledWith(1_000_000);
    vi.setSystemTime(1_005_000);
    rerender({ playing: false });
    expect(halt).toHaveBeenCalledWith(1_005_000);
    rerender({ playing: true });
    vi.setSystemTime(1_008_000);
    unmount();
    expect(halt).toHaveBeenLastCalledWith(1_008_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(halt).toHaveBeenCalledTimes(2);
  });
});
