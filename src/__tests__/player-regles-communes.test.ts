// @vitest-environment jsdom
// Les règles du lecteur écrites une seule fois après la fusion des doublons (DECISIONS.md §115) :
// ce que chaque module commun rend, à l'identique de ce que ses copies écrivaient.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { rebuildLine } from "@/components/player/nativeHostHelpers";
import { useWatchedClockRun } from "@/components/player/session/useWatchedClockRun";
import { WatchedClock } from "@/lib/playerSessionTally";
import { secondAllowed, secondSurvives } from "@/components/player/session/dualSubtitleRules";
import { timelinePosition, useSessionTimeline } from "@/components/player/session/useSessionTimeline";
import { TIMELINE_EVERY_MS, clearTimelines, timelineFields } from "@/lib/playbackTimeline";
import { audioReloadIntent, ladderReloadIntent, reloadServerPage } from "@/components/player/server/serverElement";
import { PLAYER_RELOAD_INTENT_KEY } from "@/components/PlaybackProvider";
import { habitWatch, recordsResume } from "@/components/player/session/habitWatch";
import { noteWatching } from "@/lib/resumeRewind";
import { StallSignals } from "@/components/player/session/stallSignals";
import { LONG_STALL_MS, StutterWatch } from "@/lib/slowLinkPolicy";

vi.mock("@/lib/resumeRewind", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/resumeRewind")>()),
  noteWatching: vi.fn(),
}));

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

describe("dualSubtitleRules (§115, deux sous-titres — §87)", () => {
  it("le second ne survit ni à un principal éteint, ni à devenir le principal, ni à une seconde génération", () => {
    expect(secondSurvives(3, 5)).toBe(true);
    expect(secondSurvives(null, 5)).toBe(false);
    expect(secondSurvives(5, 5)).toBe(false);
    expect(secondSurvives(3, 5, true)).toBe(false);
  });

  it("le second n'est jamais le principal, jamais sans principal ; l'éteindre est toujours permis", () => {
    expect(secondAllowed(5, 3)).toBe(true);
    expect(secondAllowed(3, 3)).toBe(false);
    expect(secondAllowed(5, null)).toBe(false);
    expect(secondAllowed(null, null)).toBe(true);
    expect(secondAllowed(null, 3)).toBe(true);
  });
});

describe("useSessionTimeline (§115, chronologie de deux minutes)", () => {
  afterEach(() => clearTimelines());

  it("timelinePosition : currentTime fini et au-delà de zéro, sinon la position suivie", () => {
    const at = (t: number) => ({ currentTime: t }) as HTMLVideoElement;
    expect(timelinePosition(at(12.5), 3)).toBe(12.5);
    expect(timelinePosition(at(0), 3)).toBe(3);
    expect(timelinePosition(at(Number.NaN), 3)).toBe(3);
    expect(timelinePosition(null, 3)).toBe(3);
  });

  it("une chronologie par clé, inscrite sous la séance lue dans l'effet, arrêtée au changement de clé", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    let session = "s1";
    const sessionOf = () => session;
    const sample = () => ({ pos: 1, recvMbps: null, aheadS: null, reserveMB: null, state: "L" as const });
    const { rerender, unmount } = renderHook(({ key }) => useSessionTimeline(key, sessionOf, sample), { initialProps: { key: "ep1" } });
    vi.advanceTimersByTime(TIMELINE_EVERY_MS);
    expect(timelineFields("stop", { session: "s1" }).timeline).toBeTruthy();
    // Même clé : rien ne se réinstalle, la séance n'est pas relue.
    session = "s2";
    rerender({ key: "ep1" });
    expect(timelineFields("stop", { session: "s2" }).timeline).toBeUndefined();
    // Clé neuve (épisode suivant en place) : la séance relue dans l'effet.
    rerender({ key: "ep2" });
    vi.advanceTimersByTime(TIMELINE_EVERY_MS);
    expect(timelineFields("stop", { session: "s2" }).timeline).toBeTruthy();
    expect(timelineFields("stop", { session: "s1" }).timeline).toBeUndefined();
    unmount();
    expect(timelineFields("stop", { session: "s2" }).timeline).toBeUndefined();
  });
});

describe("intentions de rechargement du lecteur serveur (§115)", () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });
  const carry = { lighter: { targetBps: 4_000_000, tier: 2, real: true } };

  it("le changement de piste WebKit garde l'ordre de ses clés", () => {
    const intent = audioReloadIntent({ itemId: "f", title: "Film", audioStreamIndex: 3, resumeAt: 42, carry });
    expect(Object.keys(intent)).toEqual(["itemId", "title", "audioStreamIndex", "resumeAt", "server", "carry"]);
    expect(intent.server).toBe(true);
  });

  it("la fin de l'échelle garde l'ordre de ses clés, la piste seulement si la séance en avait une", () => {
    const base = { itemId: "f", title: "Film", resumeAt: 42, attempt: 1, carry };
    expect(Object.keys(ladderReloadIntent({ ...base, audioStreamIndex: 2 }))).toEqual(["itemId", "title", "resumeAt", "attempt", "server", "audioStreamIndex", "carry"]);
    expect(Object.keys(ladderReloadIntent({ ...base, audioStreamIndex: undefined }))).toEqual(["itemId", "title", "resumeAt", "attempt", "server", "carry"]);
  });

  const element = (fail = false) => {
    const steps: string[] = [];
    const video = {
      pause: () => {
        steps.push("pause");
        if (fail) throw new Error("démonté");
      },
      removeAttribute: (name: string) => steps.push(`remove ${name}`),
      load: () => steps.push("load"),
    } as unknown as HTMLVideoElement;
    return { video, steps };
  };

  it("reloadServerPage : l'intention écrite, puis l'élément coupé — vrai", () => {
    const { video, steps } = element();
    const intent = audioReloadIntent({ itemId: "f", title: "Film", audioStreamIndex: 3, resumeAt: 42, carry });
    expect(reloadServerPage(() => intent, video)).toBe(true);
    expect(JSON.parse(sessionStorage.getItem(PLAYER_RELOAD_INTENT_KEY) ?? "null")).toEqual(intent);
    expect(steps).toEqual(["pause", "remove src", "load"]);
  });

  it("reloadServerPage : stockage refusé — faux, l'élément intact", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const { video, steps } = element();
    expect(reloadServerPage(() => ladderReloadIntent({ itemId: "f", title: "F", resumeAt: 0, attempt: 1, audioStreamIndex: undefined, carry }), video)).toBe(false);
    expect(steps).toEqual([]);
  });

  it("reloadServerPage : l'élément qui lève — faux (l'intention reste écrite, comme avant)", () => {
    const { video } = element(true);
    expect(reloadServerPage(() => audioReloadIntent({ itemId: "f", title: "F", audioStreamIndex: 1, resumeAt: 0, carry }), video)).toBe(false);
    expect(sessionStorage.getItem(PLAYER_RELOAD_INTENT_KEY)).not.toBeNull();
  });
});

describe("habitWatch (§115, habitudes de lecture — §28)", () => {
  const LONG_PAUSE_MS = 60 * 60_000;
  const el = (over: Partial<HTMLVideoElement> = {}) =>
    ({ paused: false, seeking: false, ended: false, currentTime: 600, duration: 3600, readyState: 4, ...over }) as HTMLVideoElement;

  it("recordsResume : ni banc ni scène, la scène demandée seulement hors banc", () => {
    const isScene = vi.fn(() => false);
    expect(recordsResume(undefined, isScene)).toBe(true);
    expect(recordsResume("banc", isScene)).toBe(false);
    expect(isScene).toHaveBeenCalledTimes(1);
    expect(recordsResume(undefined, () => true)).toBe(false);
  });

  it("note la lecture toutes les quinze secondes au plus, rien en pause ni pendant une scène", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const noted = vi.mocked(noteWatching);
    noted.mockClear();
    let scene = false;
    const h = habitWatch({ itemId: "f", bench: undefined, isScene: () => scene, pauseCounts: () => true, isEnded: () => false });
    h.time(el());
    h.time(el());
    expect(noted).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_016_000);
    h.time(el({ paused: true }));
    expect(noted).toHaveBeenCalledTimes(1);
    scene = true;
    h.time(el());
    expect(noted).toHaveBeenCalledTimes(1);
    scene = false;
    h.time(el());
    expect(noted).toHaveBeenCalledTimes(2);
  });

  it("recule après une longue pause comptée, et le dit ; une pause qui ne compte pas ne recule pas", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const onRewind = vi.fn();
    const h = habitWatch({ itemId: "f", bench: undefined, isScene: () => false, pauseCounts: (e) => e.readyState >= 2, isEnded: (e) => e.ended, onRewind });
    const video = el();
    h.pause(video);
    vi.setSystemTime(1_000_000 + LONG_PAUSE_MS);
    h.play(video);
    expect(video.currentTime).toBeLessThan(600);
    expect(onRewind).toHaveBeenCalledWith(video.currentTime, 1_000_000);
    const empty = el({ readyState: 0 });
    h.pause(empty);
    vi.setSystemTime(1_000_000 + 2 * LONG_PAUSE_MS);
    h.play(empty);
    expect(empty.currentTime).toBe(600);
  });

  it("ne recule ni un film fini, ni pendant un banc", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    for (const options of [{ bench: undefined, ended: true }, { bench: "banc", ended: false }]) {
      const h = habitWatch({ itemId: "f", bench: options.bench, isScene: () => false, pauseCounts: () => true, isEnded: () => options.ended });
      const video = el();
      h.pause(video);
      vi.setSystemTime(Date.now() + LONG_PAUSE_MS);
      h.play(video);
      expect(video.currentTime).toBe(600);
    }
  });
});

describe("StallSignals (§115, saccades — §78)", () => {
  const setup = () => {
    const stutter = new StutterWatch();
    const onSwitch = vi.fn();
    const onPrewarm = vi.fn();
    const stalls = new StallSignals(() => stutter, { onSwitch, onPrewarm });
    return { stutter, onSwitch, onPrewarm, stalls };
  };
  const wait = (ms: number, network = true) => ({ ms, text: `blocage de ${ms} ms (essai)`, network: () => network });

  it("un blocage de 5 s qui tient au réseau bascule ; lu à l'échéance", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { onSwitch, stalls } = setup();
    let network: boolean | null = false;
    stalls.started(() => network);
    vi.advanceTimersByTime(LONG_STALL_MS);
    expect(onSwitch).not.toHaveBeenCalled();
    network = true;
    stalls.started(() => network);
    vi.advanceTimersByTime(LONG_STALL_MS);
    expect(onSwitch).toHaveBeenCalledWith("long");
  });

  it("annulé par un saut, une fin de blocage ou le départ du pipeline : rien ne se décide", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { onSwitch, stalls } = setup();
    stalls.started(() => true);
    stalls.cancel();
    stalls.started(() => true);
    stalls.ended(Date.now(), null);
    vi.advanceTimersByTime(LONG_STALL_MS * 2);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("le 2e blocage de plus d'une seconde préchauffe, le 3e bascule ; le réseau seulement", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { onSwitch, onPrewarm, stalls } = setup();
    stalls.ended(Date.now(), wait(2000, false));
    stalls.ended(Date.now(), wait(500));
    stalls.ended(Date.now(), wait(2000));
    expect(onPrewarm).not.toHaveBeenCalled();
    stalls.ended(Date.now() + 1000, wait(2000));
    expect(onPrewarm).toHaveBeenCalledTimes(1);
    stalls.ended(Date.now() + 2000, wait(2000));
    expect(onSwitch).toHaveBeenCalledWith("repeated");
  });

  it("le réseau n'est demandé qu'en fin de blocage, s'il y en avait un", () => {
    const { stalls } = setup();
    const network = vi.fn(() => false);
    stalls.ended(0, null);
    stalls.ended(0, { ms: 2000, text: "x", network });
    expect(network).toHaveBeenCalledTimes(1);
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
