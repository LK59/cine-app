// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { REPLAY_NOTICE_MS, useReplaySubtitles } from "@/components/playerControls/useReplaySubtitles";
import { forgetReplayUsage, replayLogFields } from "@/lib/replaySubtitles";

// Le déclencheur et la fenêtre des sous-titres d'un passage rejoué (§150), côté commandes : ce que l'empreinte
// du lecteur natif ne montre pas — un recul en pause, un saut en avant, un choix au menu, le démontage.

function setup(opts: { paused?: boolean; track?: number | null } = {}) {
  const video = document.createElement("video");
  Object.defineProperty(video, "paused", { configurable: true, value: opts.paused ?? false });
  const show = vi.fn();
  const onChangeSubtitle = vi.fn();
  const host = { track: () => (opts.track === undefined ? 5 : opts.track), show };
  const hook = renderHook(() => useReplaySubtitles({ itemId: "film", videoRef: { current: video }, host, onChangeSubtitle }));
  const at = (seconds: number) =>
    act(() => {
      video.currentTime = seconds;
      video.dispatchEvent(new Event("timeupdate"));
    });
  return { video, show, onChangeSubtitle, hook, at };
}

beforeEach(() => forgetReplayUsage());

describe("useReplaySubtitles", () => {
  it("le message ne dure que le temps de le lire ; l'aide, elle, continue", () => {
    vi.useFakeTimers();
    try {
      const { hook } = setup();
      act(() => hook.result.current.noteSkip(-10, 100));
      expect(hook.result.current.notice).toBe(true);
      act(() => void vi.advanceTimersByTime(REPLAY_NOTICE_MS - 100));
      expect(hook.result.current.notice).toBe(true);
      act(() => void vi.advanceTimersByTime(200));
      expect(hook.result.current.notice).toBe(false);
      expect(hook.result.current.active).toBe(true);
      // Un second recul allonge l'aide sans remontrer le message.
      act(() => hook.result.current.noteSkip(-10, 95));
      expect(hook.result.current.notice).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("en pause, un recul n'ouvre rien", () => {
    const { show, hook } = setup({ paused: true });
    act(() => hook.result.current.noteSkip(-10, 100));
    expect(show).not.toHaveBeenCalled();
    expect(hook.result.current.active).toBe(false);
    expect(replayLogFields("film")).toEqual({});
  });

  it("sans piste à montrer, rien", () => {
    const { show, hook } = setup({ track: null });
    act(() => hook.result.current.noteSkip(-10, 100));
    expect(show).not.toHaveBeenCalled();
  });

  it("en lecture : ouverte, puis éteinte une fois la position d'avant le recul dépassée de deux secondes", async () => {
    const { show, hook, at } = setup();
    act(() => hook.result.current.noteSkip(-10, 100));
    expect(show).toHaveBeenLastCalledWith(5);
    expect(hook.result.current.active).toBe(true);
    await at(101.9);
    expect(hook.result.current.active).toBe(true);
    await at(102.1);
    expect(show).toHaveBeenLastCalledWith(null);
    expect(hook.result.current.active).toBe(false);
    expect(replayLogFields("film")).toEqual({ replaySubs: "a1 g0" });
  });

  it("un saut en avant ou un long recul ferme l'aide", () => {
    const { show, hook } = setup();
    act(() => hook.result.current.noteSkip(-10, 100));
    act(() => hook.result.current.noteSkip(10, 92));
    expect(show).toHaveBeenLastCalledWith(null);
    act(() => hook.result.current.noteSkip(-10, 100));
    act(() => hook.result.current.noteSkip(-60, 92));
    expect(show).toHaveBeenLastCalledWith(null);
  });

  it("la pastille : l'aide s'éteint et la piste devient un vrai choix, compté", () => {
    const { show, onChangeSubtitle, hook } = setup();
    act(() => hook.result.current.noteSkip(-10, 100));
    act(() => hook.result.current.keep());
    expect(show).toHaveBeenLastCalledWith(null);
    expect(onChangeSubtitle).toHaveBeenCalledWith(5);
    expect(replayLogFields("film")).toEqual({ replaySubs: "a1 g1" });
  });

  it("démontées en pleine aide, les commandes rendent l'affichage d'avant", () => {
    const { show, hook } = setup();
    act(() => hook.result.current.noteSkip(-10, 100));
    hook.unmount();
    expect(show).toHaveBeenLastCalledWith(null);
  });

  it("l'hôte n'a plus de piste à donner (une diffusion commence) : éteinte au `timeupdate` suivant", async () => {
    let track: number | null = 5;
    const video = document.createElement("video");
    Object.defineProperty(video, "paused", { configurable: true, value: false });
    const show = vi.fn();
    const hook = renderHook(() =>
      useReplaySubtitles({ itemId: "film", videoRef: { current: video }, host: { track: () => track, show }, onChangeSubtitle: vi.fn() })
    );
    act(() => hook.result.current.noteSkip(-10, 100));
    track = null;
    await act(() => {
      video.currentTime = 91;
      video.dispatchEvent(new Event("timeupdate"));
    });
    expect(show).toHaveBeenLastCalledWith(null);
  });
});
