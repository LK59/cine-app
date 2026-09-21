// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

const toastError = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ success: vi.fn(), error: toastError, info: vi.fn() }) }));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string, vars?: Record<string, unknown>) => (vars ? `${k}:${JSON.stringify(vars)}` : k),
}));

import { playSeriesNextEpisode, usePlaySeriesNextEpisode } from "@/lib/playSeriesNextEpisode";

const SERIES = { jellyfinItemId: "abc", title: "Dark" };
const EPISODES = {
  seasons: [{ seasonNumber: 1, episodes: [{ jellyfinItemId: "e1", title: "Secrets", seasonNumber: 1, episodeNumber: 1 }] }],
  nextEpisode: { itemId: "e1", title: "Secrets", resumeTicks: 0 },
};

beforeEach(() => toastError.mockClear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * « Lire » sur une série, hors ligne.
 *
 * `fetch` levait « Load failed », que personne ne rattrapait : un rejet non géré dans server.log,
 * et rien du tout à l'écran. Et quand la réponse arrivait sans épisode à lancer, le `false` rendu
 * n'était lu par personne non plus.
 */
describe("playSeriesNextEpisode", () => {
  it("rend false au lieu de lever quand le réseau manque", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Load failed")));
    const play = vi.fn();
    await expect(playSeriesNextEpisode({ play }, SERIES)).resolves.toBe(false);
    expect(play).not.toHaveBeenCalled();
  });

  it("rend false sur une réponse illisible", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.reject(new SyntaxError("bad")) }));
    await expect(playSeriesNextEpisode({ play: vi.fn() }, SERIES)).resolves.toBe(false);
  });

  it("lance le prochain épisode quand tout va bien", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => EPISODES }));
    const play = vi.fn();
    await expect(playSeriesNextEpisode({ play }, SERIES)).resolves.toBe(true);
    expect(play).toHaveBeenCalledWith(expect.objectContaining({ itemId: "e1", resumeAt: 0 }));
  });
});

describe("usePlaySeriesNextEpisode", () => {
  it("dit quand rien n'a démarré", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Load failed")));
    const playback = { play: vi.fn() };
    const { result } = renderHook(() => usePlaySeriesNextEpisode(playback));
    await act(async () => {
      await result.current(SERIES);
    });
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("cinema.playSeriesFailed"));
    expect(toastError.mock.calls[0][0]).toContain("Dark");
  });

  it("ne dit rien quand l'épisode démarre", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => EPISODES }));
    const playback = { play: vi.fn() };
    const { result } = renderHook(() => usePlaySeriesNextEpisode(playback));
    await act(async () => {
      await result.current(SERIES);
    });
    expect(toastError).not.toHaveBeenCalled();
  });
});
