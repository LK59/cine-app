import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioKeepAwake, KEEP_AWAKE_MAX_MS, KEEP_AWAKE_TAIL_MS } from "@/components/player/audioKeepAwake";

// La veille de la sortie audio pendant une pause (17/11/2026, gardée par le lecteur natif depuis §196) : cinq
// minutes au plus, puis la sortie peut s'endormir (`awake()` faux).
function fakeContext() {
  const calls: string[] = [];
  class FakeContext {
    destination = {};
    createOscillator() {
      return { connect: (g: { connect: () => unknown }) => g, start: () => calls.push("start"), stop: () => calls.push("stop"), disconnect: () => {} };
    }
    createGain() {
      return { gain: { value: 1 }, connect: () => ({}) };
    }
    resume() {
      return Promise.resolve();
    }
    suspend() {
      return Promise.resolve();
    }
    close() {
      calls.push("close");
      return Promise.resolve();
    }
  }
  (globalThis as { window?: unknown }).window = { AudioContext: FakeContext };
  return calls;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { window?: unknown }).window;
});

describe("AudioKeepAwake", () => {
  it("éveillée pendant cinq minutes de pause, endormie ensuite", () => {
    const calls = fakeContext();
    const keep = new AudioKeepAwake();
    expect(keep.awake()).toBe(false);
    keep.start();
    expect(keep.awake()).toBe(true);
    vi.advanceTimersByTime(KEEP_AWAKE_MAX_MS - 1);
    expect(keep.awake()).toBe(true);
    vi.advanceTimersByTime(2);
    expect(keep.awake()).toBe(false);
    expect(calls).toContain("stop");
    expect(KEEP_AWAKE_MAX_MS).toBe(5 * 60_000);
  });

  it("à la reprise, encore une seconde ; fermée, elle repart à la pause suivante", () => {
    const calls = fakeContext();
    const keep = new AudioKeepAwake();
    keep.start();
    keep.release();
    vi.advanceTimersByTime(KEEP_AWAKE_TAIL_MS - 1);
    expect(keep.awake()).toBe(true);
    vi.advanceTimersByTime(2);
    expect(keep.awake()).toBe(false);
    keep.dispose();
    expect(calls).toContain("close");
    keep.start();
    expect(keep.awake()).toBe(true);
  });
});
