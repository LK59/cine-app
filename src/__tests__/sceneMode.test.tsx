// @vitest-environment jsdom
// Une scène ouverte depuis une réplique n'est pas une reprise — sauf après dix minutes jouées
// (DECISIONS.md §91, 14/10/2026). L'horloge, ce que la séance emporte, et le passage d'une scène à
// une lecture ordinaire, avec le vrai `usePlaybackSession`.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: { getItemUserData: vi.fn(), getSessions: vi.fn() } }));

import { SceneClock, SCENE_NORMAL_AFTER_MS, sceneClockFor, sceneCarryOf, sceneLogFields, isSceneNow, useSceneMode, __resetSceneClocks } from "@/lib/sceneMode";
import { directReloadIntent, parseReloadIntent } from "@/lib/serverReload";
import { recoverLostPosition } from "@/lib/lostStopPosition";
import { usePlaybackSession } from "@/lib/usePlaybackSession";
import { jellyfin } from "@/lib/clients/jellyfin";

beforeEach(() => __resetSceneClocks());

describe("SceneClock", () => {
  it("compte le temps joué, pas le temps passé en pause", () => {
    const clock = new SceneClock();
    let now = 0;
    for (let i = 0; i < 300; i++) clock.tick((now += 1000), true);
    // Dix minutes en pause : rien de plus.
    for (let i = 0; i < 600; i++) clock.tick((now += 1000), false);
    expect(clock.normal).toBe(false);
    expect(clock.watchedMs).toBeCloseTo(299_000, -3);
  });

  it("devient une lecture ordinaire à dix minutes jouées, une seule fois", () => {
    const clock = new SceneClock();
    let now = 0;
    const flips: number[] = [];
    for (let i = 0; i < 700; i++) if (clock.tick((now += 1000), true)) flips.push(i);
    expect(clock.normal).toBe(true);
    expect(flips).toHaveLength(1);
    expect(clock.watchedMs).toBeGreaterThanOrEqual(SCENE_NORMAL_AFTER_MS);
  });

  it("un onglet endormi ne compte pas comme joué", () => {
    const clock = new SceneClock();
    clock.tick(0, true);
    clock.tick(30 * 60_000, true);
    expect(clock.normal).toBe(false);
  });

  it("reprend le temps emporté par un rechargement", () => {
    expect(new SceneClock(SCENE_NORMAL_AFTER_MS).normal).toBe(true);
    expect(new SceneClock(60_000).watchedMs).toBe(60_000);
  });
});

describe("la séance", () => {
  it("une lecture ordinaire n'a pas d'horloge ni de champs au journal", () => {
    const session = { itemId: "a", openId: 1 };
    expect(sceneClockFor(session)).toBeNull();
    expect(isSceneNow(session)).toBe(false);
    expect(sceneLogFields(session)).toEqual({});
    expect(sceneCarryOf(session)).toBeUndefined();
  });

  it("une même lecture garde son horloge d'un lecteur à l'autre (relais natif → serveur)", () => {
    const session = { itemId: "a", openId: 2, scene: true };
    const clock = sceneClockFor(session)!;
    clock.watchedMs = 120_000;
    expect(sceneClockFor({ ...session })).toBe(clock);
    expect(sceneCarryOf(session)).toEqual({ watchedMs: 120_000 });
    expect(sceneLogFields(session)).toEqual({ scene: true });
    // Une autre ouverture du même titre est une autre lecture.
    expect(sceneClockFor({ ...session, openId: 3 })).not.toBe(clock);
  });

  it("devenue lecture : `sceneNormal` au journal, et plus rien à emporter", () => {
    const session = { itemId: "a", openId: 4, scene: true, sceneWatchedMs: SCENE_NORMAL_AFTER_MS };
    expect(isSceneNow(session)).toBe(false);
    expect(sceneLogFields(session)).toEqual({ scene: true, sceneNormal: true });
    expect(sceneCarryOf(session)).toBeUndefined();
  });
});

describe("le rechargement de page (WebKit)", () => {
  it("emporte la scène et la relit", () => {
    const session = { itemId: "film", title: "Film", resumeAt: 100, openId: 5, scene: true };
    sceneClockFor(session)!.watchedMs = 42_000;
    const intent = directReloadIntent(session, undefined, "s1", "raison", 1);
    expect(intent.carry?.scene).toEqual({ watchedMs: 42_000 });
    expect(parseReloadIntent(JSON.stringify(intent))?.carry?.scene).toEqual({ watchedMs: 42_000 });
  });

  it("une lecture ordinaire n'emporte rien", () => {
    const intent = directReloadIntent({ itemId: "film", title: "Film", openId: 6 }, undefined, undefined, undefined, 1);
    expect(intent.carry?.scene).toBeUndefined();
    expect(parseReloadIntent(JSON.stringify({ itemId: "x", carry: { scene: { watchedMs: "?" } } }))?.carry?.scene).toBeUndefined();
  });
});

describe("le bilan perdu d'une scène", () => {
  const fields = { why: "lost", itemId: "0123456789abcdef0123456789abcdef", at: 4000, lateByMs: 1000 };
  it("ne rend aucune position à Jellyfin", async () => {
    expect(await recoverLostPosition("jf", { ...fields, scene: true })).toBe("sans objet");
    expect(jellyfin.getItemUserData).not.toHaveBeenCalled();
  });
});

describe("useSceneMode + usePlaybackSession — le passage à une lecture ordinaire", () => {
  function Harness({ scene }: { scene: boolean }) {
    const mode = useSceneMode({ itemId: "film", openId: 77, scene }, () => true);
    usePlaybackSession(
      () => 4000,
      mode.active ? null : { itemId: "film", playSessionId: "p", mediaSourceId: "film", announce: true },
      () => false
    );
    return null;
  }
  const playbackCalls = () =>
    (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith("/api/jellyfin/playback/"));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rien pendant dix minutes, puis l'annonce et les battements d'une lecture", () => {
    const { unmount } = render(<Harness scene />);
    act(() => void vi.advanceTimersByTime(9 * 60_000));
    expect(playbackCalls()).toEqual([]);
    act(() => void vi.advanceTimersByTime(60_000 + 2_000));
    expect(playbackCalls()[0]).toBe("/api/jellyfin/playback/playing");
    act(() => void vi.advanceTimersByTime(31_000));
    expect(playbackCalls()).toContain("/api/jellyfin/playback/progress");
    unmount();
    expect(playbackCalls().at(-1)).toBe("/api/jellyfin/playback/stop");
  });

  it("une scène fermée avant dix minutes n'écrit aucun arrêt", () => {
    const { unmount } = render(<Harness scene />);
    act(() => void vi.advanceTimersByTime(5 * 60_000));
    unmount();
    expect(playbackCalls()).toEqual([]);
  });
});
