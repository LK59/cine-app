// @vitest-environment jsdom
// La suite commune « fermer le lecteur » / « épisode suivant » des quatre hôtes (DECISIONS.md §114) :
// l'ordre des étapes, la garde de l'hôte, ce que chaque hôte peut omettre.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const refreshAfterPlayback = vi.fn((_reported: Promise<void>, _itemId: string | null) => Promise.resolve());
vi.mock("@/lib/swr", () => ({ refreshAfterPlayback: (r: Promise<void>, i: string | null) => refreshAfterPlayback(r, i) }));

import { advanceTo, closePlayerSession, PLAYER_CLOSE_MS, type PlayerCloseSteps } from "@/components/player/playerClose";

/** Chaque étape note son nom dans `order` ; la garde accepte une fois. */
function steps(order: string[], over: Partial<PlayerCloseSteps> = {}) {
  let claimed = false;
  const reported = Promise.resolve();
  const s: PlayerCloseSteps = {
    claim: () => {
      order.push("claim");
      if (claimed) return false;
      claimed = true;
      return true;
    },
    leaveFullscreen: true,
    reportStop: () => order.push("reportStop"),
    stopReporting: () => {
      order.push("stopReporting");
      return reported;
    },
    release: () => order.push("release"),
    setClosing: () => order.push("setClosing"),
    playback: { close: (openId) => order.push(`close(${openId})`) },
    openId: 7,
    itemId: "film-1",
    refresh: true,
    ...over,
  };
  return { s, reported };
}

describe("closePlayerSession", () => {
  let exitFullscreen: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    refreshAfterPlayback.mockClear();
    exitFullscreen = vi.fn(() => Promise.resolve());
    Object.defineProperty(document, "exitFullscreen", { value: exitFullscreen, configurable: true });
    Object.defineProperty(document, "fullscreenElement", { value: null, configurable: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dans l'ordre : garde, ligne stop, arrêt Jellyfin, téléviseur, fondu — puis close(openId) au terme du fondu", () => {
    const order: string[] = [];
    const { s, reported } = steps(order);
    expect(closePlayerSession(s)).toBe(true);
    expect(order).toEqual(["claim", "reportStop", "stopReporting", "release", "setClosing"]);
    // La relecture des vues part tout de suite, avec la promesse de l'arrêt — pas au terme du fondu.
    expect(refreshAfterPlayback).toHaveBeenCalledTimes(1);
    expect(refreshAfterPlayback.mock.calls[0][0]).toBe(reported);
    expect(refreshAfterPlayback.mock.calls[0][1]).toBe("film-1");
    vi.advanceTimersByTime(PLAYER_CLOSE_MS - 1);
    expect(order).not.toContain("close(7)");
    vi.advanceTimersByTime(1);
    expect(order.at(-1)).toBe("close(7)");
    expect(PLAYER_CLOSE_MS).toBe(200);
  });

  it("une seule fermeture : la garde refusée, rien ne part — ni ligne, ni arrêt, ni relecture, ni close", () => {
    const order: string[] = [];
    const { s } = steps(order);
    closePlayerSession(s);
    vi.advanceTimersByTime(PLAYER_CLOSE_MS);
    order.length = 0;
    expect(closePlayerSession(s)).toBe(false);
    vi.advanceTimersByTime(PLAYER_CLOSE_MS * 2);
    expect(order).toEqual(["claim"]);
    expect(refreshAfterPlayback).toHaveBeenCalledTimes(1);
  });

  it("l'openId lu à l'appel : un film lancé pendant le fondu n'est pas refermé à sa place", () => {
    const order: string[] = [];
    const { s } = steps(order);
    closePlayerSession(s);
    s.openId = 8;
    vi.advanceTimersByTime(PLAYER_CLOSE_MS);
    expect(order).toContain("close(7)");
    expect(order).not.toContain("close(8)");
  });

  it("pas de relecture après une scène (§91)", () => {
    const { s } = steps([], { refresh: false });
    closePlayerSession(s);
    expect(refreshAfterPlayback).not.toHaveBeenCalled();
  });

  it("le hors ligne : ni ligne stop ni téléviseur ; Chromecast : ni fondu", () => {
    const order: string[] = [];
    const { s } = steps(order, { reportStop: undefined, release: undefined, setClosing: undefined });
    closePlayerSession(s);
    vi.advanceTimersByTime(PLAYER_CLOSE_MS);
    expect(order).toEqual(["claim", "stopReporting", "close(7)"]);
  });

  it("quitte le plein écran seulement s'il y en a un, et seulement si l'hôte le demande", () => {
    closePlayerSession(steps([]).s);
    expect(exitFullscreen).not.toHaveBeenCalled();

    Object.defineProperty(document, "fullscreenElement", { value: document.body, configurable: true });
    closePlayerSession(steps([], { leaveFullscreen: false }).s);
    expect(exitFullscreen).not.toHaveBeenCalled();

    closePlayerSession(steps([]).s);
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("un refus de exitFullscreen ne remonte pas", async () => {
    Object.defineProperty(document, "fullscreenElement", { value: document.body, configurable: true });
    exitFullscreen.mockImplementation(() => Promise.reject(new Error("refusé")));
    const order: string[] = [];
    expect(() => closePlayerSession(steps(order).s)).not.toThrow();
    await Promise.resolve();
    expect(order).toContain("setClosing");
  });
});

describe("advanceTo", () => {
  const make = (order: string[], over = false) => ({
    over,
    reportStop: () => order.push("reportStop"),
    stopReporting: () => order.push("stopReporting"),
    playback: { advance: (next: { itemId: string }) => order.push(`advance(${next.itemId})`) },
  });

  it("ligne stop, arrêt Jellyfin, puis advance — sans fondu ni close", () => {
    const order: string[] = [];
    expect(advanceTo({ itemId: "ep-2", title: "Épisode 2" }, make(order))).toBe(true);
    expect(order).toEqual(["reportStop", "stopReporting", "advance(ep-2)"]);
  });

  it("transmet la position que le menu « Épisodes » connaît", () => {
    const advance = vi.fn();
    advanceTo({ itemId: "ep-5", title: "Épisode 5", resumeAt: 312 }, { over: false, reportStop: () => {}, stopReporting: () => {}, playback: { advance } });
    expect(advance).toHaveBeenCalledWith({ itemId: "ep-5", title: "Épisode 5", resumeAt: 312 });
  });

  it("rien sur une séance close, ni sans épisode", () => {
    const order: string[] = [];
    expect(advanceTo({ itemId: "ep-2", title: "Épisode 2" }, make(order, true))).toBe(false);
    expect(advanceTo(null, make(order))).toBe(false);
    expect(order).toEqual([]);
  });
});
