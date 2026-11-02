// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useState } from "react";
import { buildSeances } from "@/lib/activity/seances";
import { diagnoseTitles } from "@/lib/activity/diagnosis";
import type { LogRecord } from "@/lib/activity/logReader";
import type { OfflineDownload } from "@/lib/offline/downloads";

/**
 * La séance du lecteur hors ligne au journal du lecteur (02/11/2026). Il n'écrivait rien : deux
 * semaines d'épisodes regardés sur l'appareil n'existaient que pour Jellyfin, et la page Activité ne
 * les montrait pas.
 */
const reportPlayback = vi.fn();
const saveUnsentStop = vi.fn();
const clearUnsentStop = vi.fn();
vi.mock("@/lib/reportPlayback", () => ({ reportPlayback: (...args: unknown[]) => reportPlayback(...args) }));
vi.mock("@/lib/unsentStop", () => ({
  saveUnsentStop: (...args: unknown[]) => saveUnsentStop(...args),
  touchUnsentStop: vi.fn(),
  clearUnsentStop: (...args: unknown[]) => clearUnsentStop(...args),
}));

const { useOfflineSessionLog } = await import("@/components/offline/useOfflineSessionLog");

const download = {
  id: "job1",
  itemId: "ep7",
  title: "Lucifer — S04E07 · Le propre du Diable",
  codec: "hevc",
  quality: "standard",
  audioLabel: "English — 5.1",
  state: "done",
} as unknown as OfflineDownload;

function mount() {
  const video = document.createElement("video");
  const counts = { current: { device: 5_000_000, server: 0 } };
  const hook = renderHook(
    ({ ready }) => {
      const [videoRef] = useState(() => ({ current: video }));
      return useOfflineSessionLog(videoRef, ready, download, counts);
    },
    { initialProps: { ready: false } }
  );
  return { hook, video };
}

const lines = (kind: string) => reportPlayback.mock.calls.filter(([k]) => k === kind).map(([, fields]) => fields as Record<string, unknown>);

describe("séance du lecteur hors ligne", () => {
  beforeEach(() => {
    reportPlayback.mockClear();
    saveUnsentStop.mockClear();
    clearUnsentStop.mockClear();
  });

  it("un start à l'ouverture, un stop au démontage, sous la même séance", () => {
    const { hook } = mount();
    expect(lines("start")).toHaveLength(0);
    hook.rerender({ ready: true });
    const [start] = lines("start");
    expect(start).toMatchObject({ player: "hors-ligne", itemId: "ep7", title: download.title, video: "hevc" });
    expect(typeof start.session).toBe("string");
    // Le bilan gardé sur l'appareil dès l'ouverture : une page tuée l'enverra au lancement suivant.
    expect(saveUnsentStop).toHaveBeenCalledWith(start.session, expect.objectContaining({ player: "hors-ligne" }), expect.any(Number), { livesHere: true });
    hook.unmount();
    const [stop] = lines("stop");
    expect(stop).toMatchObject({ session: start.session, why: "close", player: "hors-ligne", deviceMB: 5 });
    expect(clearUnsentStop).toHaveBeenCalledWith(start.session);
  });

  it("« Épisode suivant » se dit `next`", () => {
    const { hook } = mount();
    hook.rerender({ ready: true });
    hook.result.current.endAs("next");
    hook.unmount();
    expect(lines("stop")[0].why).toBe("next");
  });

  it("rien tant que le lecteur n'est pas prêt", () => {
    const { hook } = mount();
    hook.unmount();
    expect(reportPlayback).not.toHaveBeenCalled();
  });
});

describe("la séance hors ligne dans l'activité", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1";
  const base = { user: "a", itemId: "x", title: "T", agent: IPHONE, player: "hors-ligne", path: "hors-ligne", _file: "player.log" };
  const records = (session: string, t: number, extra: Record<string, unknown> = {}) =>
    [
      { ...base, ...extra, session, kind: "start", _t: t, _line: 1 },
      { ...base, ...extra, session, kind: "stop", watched: 600, why: "close", _t: t + 700_000, _line: 2 },
    ] as LogRecord[];

  it("se lit comme lecteur hors ligne, avec son temps regardé ; une reconstituée le dit", () => {
    const [live] = buildSeances(records("s1", 1_790_000_000_000));
    expect(live).toMatchObject({ player: "hors-ligne", watched: 600, device: "iPhone · Safari" });
    expect(live.retro).toBeUndefined();
    const [old] = buildSeances(records("retro-1", 1_790_000_000_000, { retro: true }));
    expect(old.retro).toBe(true);
  });

  it("n'entre pas dans le diagnostic « fichier ou appareil » : ce n'est pas le fichier de la bibliothèque", () => {
    const failing = (session: string, user: string, t: number) =>
      [
        { user, itemId: "x", title: "T", agent: IPHONE, session, kind: "start", _t: t, _file: "player.log", _line: 1 },
        { user, itemId: "x", title: "T", agent: IPHONE, session, kind: "stall", position: 30, _t: t + 30_000, _file: "player.log", _line: 2 },
      ] as LogRecord[];
    const all = buildSeances([...failing("f1", "b", 1_790_000_000_000), ...failing("f2", "c", 1_790_000_100_000), ...records("s1", 1_790_000_200_000)]);
    const d = diagnoseTitles(all).find((x) => x.itemId === "x");
    expect(d?.viewers.map((v) => v.user).sort()).toEqual(["b", "c"]);
  });
});
