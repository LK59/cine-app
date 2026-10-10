// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  PAUSED_PICTURE_MS,
  REFUSAL_CONFIRM_MS,
  playbackRefused,
  useIntroPlaybackStarted,
  useServerIntroPicture,
  type IntroMedia,
} from "@/lib/introEnd";

// Quand l'ouverture de la lecture (DECISIONS.md §60) laisse la place au film — sans monter un lecteur.

function fakeMedia(state: Partial<Pick<IntroMedia, "paused" | "seeking" | "readyState" | "currentTime">> = {}) {
  const target = new EventTarget();
  return Object.assign(target, { paused: false, seeking: false, readyState: 1, currentTime: 0, ...state }) as unknown as IntroMedia & EventTarget & {
    paused: boolean;
    seeking: boolean;
    readyState: number;
    currentTime: number;
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("lecteur natif — useIntroPlaybackStarted", () => {
  it("une reprise dont le média n'est pas encore là : l'élément arrêté sans image n'est pas un refus", () => {
    // Avant : « arrêté et aucune attente armée » suffisait, et l'ouverture s'effaçait au bout de
    // 1,5 s sur un écran noir sans roue, le temps que le média de la reprise arrive (réseau lent).
    const media = fakeMedia({ paused: true, readyState: 1 });
    expect(playbackRefused(media, false)).toBe(false);
    const { result } = renderHook(() => useIntroPlaybackStarted(true, { current: media }, { current: false }));
    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current).toBe(false);

    // Le média arrive, la lecture part : l'horloge avance.
    media.paused = false;
    media.readyState = 4;
    media.currentTime = 0.5;
    act(() => {
      media.dispatchEvent(new Event("timeupdate"));
    });
    expect(result.current).toBe(true);
  });

  it("un saut en cours n'est pas un refus non plus", () => {
    const media = fakeMedia({ paused: true, readyState: 2, seeking: true });
    expect(playbackRefused(media, false)).toBe(false);
  });

  it("la lecture automatique refusée, arrêtée sur une image : l'ouverture s'efface pour le bouton Lecture", () => {
    const media = fakeMedia({ paused: true, readyState: 4 });
    const { result } = renderHook(() => useIntroPlaybackStarted(true, { current: media }, { current: false }));
    act(() => vi.advanceTimersByTime(REFUSAL_CONFIRM_MS + 600));
    expect(result.current).toBe(true);
  });

  it("le passage « arrêté sur une image » avant l'appel à play() n'est pas un refus", () => {
    const media = fakeMedia({ paused: true, readyState: 4 });
    const { result } = renderHook(() => useIntroPlaybackStarted(true, { current: media }, { current: false }));
    act(() => vi.advanceTimersByTime(500));
    media.paused = false; // play() appelé, la lecture démarre
    act(() => vi.advanceTimersByTime(REFUSAL_CONFIRM_MS + 1000));
    expect(result.current).toBe(false);
  });

  it("l'atterrissage de l'ouverture n'est pas de la lecture", () => {
    const media = fakeMedia({ readyState: 4 });
    const { result } = renderHook(() => useIntroPlaybackStarted(true, { current: media }, { current: true }));
    act(() => {
      media.seeking = true;
      media.currentTime = 0.27;
      media.dispatchEvent(new Event("seeking"));
      media.seeking = false;
      media.dispatchEvent(new Event("seeked"));
      media.dispatchEvent(new Event("timeupdate"));
    });
    expect(result.current).toBe(false);
    act(() => {
      media.currentTime = 0.5;
      media.dispatchEvent(new Event("timeupdate"));
    });
    expect(result.current).toBe(true);
  });

  it("ne relit plus rien une fois démonté", () => {
    const media = fakeMedia({ paused: true, readyState: 4 });
    const { unmount } = renderHook(() => useIntroPlaybackStarted(true, { current: media }, { current: false }));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("lecteur serveur — useServerIntroPicture", () => {
  it("attend la fin du saut de reprise et de quoi avancer", async () => {
    const media = fakeMedia({ readyState: 2, seeking: true });
    const { result } = renderHook(() => useServerIntroPicture(false, { current: media }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBe(false);
    act(() => {
      media.seeking = false;
      media.readyState = 3;
      media.dispatchEvent(new Event("seeked"));
    });
    expect(result.current).toBe(true);
  });

  it("la lecture automatique refusée sur iOS : arrêté sur une image sans jamais remplir, l'ouverture s'efface quand même", async () => {
    // Avant : `readyState` ≥ 3 seulement, et un élément arrêté à 2 — aucun événement ne suit un
    // `NotAllowedError` — gardait l'ouverture posée pour toujours sur le bouton Lecture.
    const media = fakeMedia({ paused: true, readyState: 2 });
    const { result } = renderHook(() => useServerIntroPicture(false, { current: media }));
    await act(async () => {
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(PAUSED_PICTURE_MS - 600));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1200));
    expect(result.current).toBe(true);
  });

  it("rien tant que le chargement n'est pas fini", () => {
    const media = fakeMedia({ readyState: 4 });
    const { result } = renderHook(() => useServerIntroPicture(true, { current: media }));
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBe(false);
  });
});
