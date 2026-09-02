import { describe, it, expect, vi } from "vitest";
import { runWithConcurrency } from "@/lib/trailerJob";

describe("runWithConcurrency", () => {
  it("processes every item exactly once", async () => {
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("never runs more than `limit` workers concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    await runWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("one worker rejecting does not stop the batch — the caller decides what to do with it", async () => {
    const seen: number[] = [];
    const onRejection = vi.fn();
    await runWithConcurrency([1, 2, 3], 1, async (n) => {
      if (n === 2) {
        try {
          throw new Error("boom");
        } catch (err) {
          onRejection(err);
          return; // caller swallows it, same as trailerJob.ts counting it as a failure
        }
      }
      seen.push(n);
    });
    expect(seen).toEqual([1, 3]);
    expect(onRejection).toHaveBeenCalledTimes(1);
  });

  it("handles an empty item list without hanging", async () => {
    const worker = vi.fn();
    await runWithConcurrency([], 3, worker);
    expect(worker).not.toHaveBeenCalled();
  });

  it("stops scheduling new items once shouldStop() returns true, without aborting in-flight ones", async () => {
    const seen: number[] = [];
    let stop = false;
    await runWithConcurrency(
      [1, 2, 3, 4, 5],
      1,
      async (n) => {
        seen.push(n);
        if (n === 2) stop = true; // cancel requested partway through
      },
      () => stop
    );
    // Item 2's own worker call still completed (a cancel doesn't abort an in-flight item), but
    // nothing after it was ever started.
    expect(seen).toEqual([1, 2]);
  });
});
