// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useSleepTimer } from "@/lib/useSleepTimer";
import { sleepFading, sleepTimerStore } from "@/lib/sleepTimer";

/**
 * Le moteur de la minuterie sur un vrai élément : la descente du son, la pause, le volume rendu —
 * et un décompte qui continue quand le lecteur est remonté (épisode suivant, reconstruction).
 */

let now = 0;

function fakeVideo(): HTMLVideoElement {
  const video = document.createElement("video");
  let paused = false;
  Object.defineProperty(video, "paused", { get: () => paused, configurable: true });
  video.pause = vi.fn(() => {
    paused = true;
  });
  video.volume = 0.8;
  return video;
}

/**
 * Fait passer `ms` de film en un seul battement — le moteur mesure le temps entre deux battements,
 * comme dans un onglet en arrière-plan dont les minuteurs sont espacés.
 */
async function advance(ms: number) {
  now += ms;
  await act(async () => {
    vi.advanceTimersByTime(250);
  });
}

beforeEach(() => {
  now = 0;
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  sleepTimerStore.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sleepTimerStore.clear();
});

describe("useSleepTimer", () => {
  it("baisse le son, met en pause, rend le volume et prévient l'hôte", async () => {
    const video = fakeVideo();
    const onSlept = vi.fn();
    renderHook(() => useSleepTimer({ current: video }, onSlept));
    act(() => sleepTimerStore.choose("15"));

    await advance(15 * 60_000 - 2500);
    expect(video.volume).toBeLessThan(0.8);
    expect(sleepFading()).toBe(true);
    expect(onSlept).not.toHaveBeenCalled();

    await advance(2500);
    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(video.volume).toBeCloseTo(0.8, 5);
    expect(sleepFading()).toBe(false);
    expect(onSlept).toHaveBeenCalledWith("15");
    expect(sleepTimerStore.get()).toMatchObject({ mode: "off", fired: "15" });
  });

  it("ne compte pas pendant une pause", async () => {
    const video = fakeVideo();
    video.pause();
    renderHook(() => useSleepTimer({ current: video }, vi.fn()));
    act(() => sleepTimerStore.choose("15"));
    await advance(60_000);
    expect(sleepTimerStore.get().remainingMs).toBe(15 * 60_000);
  });

  it("« Continuer » pendant la descente rend le son tout de suite", async () => {
    const video = fakeVideo();
    renderHook(() => useSleepTimer({ current: video }, vi.fn()));
    act(() => sleepTimerStore.choose("15"));
    await advance(15 * 60_000 - 2000);
    expect(video.volume).toBeLessThan(0.8);
    act(() => sleepTimerStore.continue());
    await advance(250);
    expect(video.volume).toBeCloseTo(0.8, 5);
    expect(video.pause).not.toHaveBeenCalled();
  });

  it("continue son décompte dans le lecteur suivant, remonté pour l'épisode d'après", async () => {
    const first = fakeVideo();
    const onSlept = vi.fn();
    const one = renderHook(() => useSleepTimer({ current: first }, onSlept));
    act(() => sleepTimerStore.choose("15"));
    await advance(10 * 60_000);
    one.unmount();

    const second = fakeVideo();
    renderHook(() => useSleepTimer({ current: second }, onSlept));
    await advance(5 * 60_000);
    expect(first.pause).not.toHaveBeenCalled();
    expect(second.pause).toHaveBeenCalledTimes(1);
    expect(onSlept).toHaveBeenCalledWith("15");
  });

  it("retient l'épisode à sa fin avec « Fin de l'épisode », et seulement alors", () => {
    const onSlept = vi.fn();
    const { result } = renderHook(() => useSleepTimer({ current: fakeVideo() }, onSlept));
    expect(result.current.blocksAdvance).toBe(false);
    expect(result.current.holdAtEnd()).toBe(false);
    expect(onSlept).not.toHaveBeenCalled();

    act(() => sleepTimerStore.choose("episode"));
    expect(result.current.blocksAdvance).toBe(true);
    expect(result.current.holdAtEnd()).toBe(true);
    expect(onSlept).toHaveBeenCalledWith("episode");
  });
});
