// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, renderHook, screen, fireEvent } from "@testing-library/react";

/**
 * « Revenir au début de la scène » dans les commandes (DECISIONS.md §143) : décidé à la première image, une fois
 * par séance ; coupé (défaut), jamais montré mais retenu pour le bilan ; montré, huit secondes, son issue au journal.
 */

const config = vi.hoisted(() => ({ data: undefined as Record<string, unknown> | undefined }));
vi.mock("swr", () => ({ default: () => ({ data: config.data }) }));
vi.mock("@/lib/swr", () => ({ fetcher: () => null, followOnlyOptions: {} }));
const sent = vi.hoisted(() => [] as [string, Record<string, unknown>][]);
vi.mock("@/lib/reportPlayback", () => ({ reportPlayback: (kind: string, fields: Record<string, unknown>) => sent.push([kind, fields]) }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key }));

import { useSceneRestart } from "@/components/playerControls/useSceneRestart";
import { PlayerPrompts } from "@/components/playerControls/PlayerPrompts";
import { forgetSceneRestart, noteLastPlayedAt, sceneRestartLogFields } from "@/lib/sceneRestartSession";
import type { XrayPlayerPayload } from "@/lib/xray/scenes";

const ID = "f".repeat(32);
const NOW = Date.parse("2026-11-10T20:00:00Z");
const person = { personId: 1, name: "A", character: "A", photo: null, screenTime: 10, confidence: 0.9 };
const PAYLOAD: XrayPlayerPayload = {
  status: "done",
  complete: true,
  analyzedUntil: 600,
  speechShare: 0.5,
  scenes: [
    { start: 0, end: 100, people: [person], entry: 0, cut: { ok: true, why: "début" } },
    { start: 100, end: 300, people: [person], entry: 98, cut: { ok: true, why: "deux-signaux" } },
    { start: 300, end: 600, people: [person], entry: 300, cut: { ok: false, why: "même-lieu" } },
  ],
};

type Props = Parameters<typeof useSceneRestart>[0];
const base: Props = {
  itemId: ID,
  offered: true,
  payload: PAYLOAD,
  currentTime: 0,
  playing: false,
  settled: false,
  castActive: false,
  introSkip: null,
  recapSkip: null,
  creditsStart: null,
};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["setTimeout", "clearTimeout", "Date"] });
  forgetSceneRestart();
  sent.length = 0;
  config.data = undefined;
  noteLastPlayedAt(ID, "2026-11-09T21:00:00.000Z");
});
afterEach(() => vi.useRealTimers());

describe("useSceneRestart", () => {
  it("coupé : jamais montré, la décision retenue pour le bilan, rien au journal", () => {
    const { result, rerender } = renderHook((p: Props) => useSceneRestart(p), { initialProps: base });
    rerender({ ...base, currentTime: 150, playing: true, settled: true });
    expect(result.current.prompt).toBeNull();
    expect(sceneRestartLogFields(ID)).toEqual({ sceneRestart: "aurait-proposé" });
    expect(sent).toEqual([]);
  });

  it("sans les acteurs à l'écran : rien ne tourne, rien n'est retenu", () => {
    const { rerender } = renderHook((p: Props) => useSceneRestart(p), { initialProps: { ...base, offered: false } });
    rerender({ ...base, offered: false, currentTime: 150, playing: true, settled: true });
    expect(sceneRestartLogFields(ID)).toEqual({});
  });

  it("allumé : montré huit secondes puis « ignoré », une ligne `debut-scene`", () => {
    config.data = { sceneRestartAvailable: true };
    const { result, rerender } = renderHook((p: Props) => useSceneRestart(p), { initialProps: base });
    rerender({ ...base, currentTime: 150, playing: true, settled: true });
    expect(result.current.prompt).toEqual({ target: 98 });
    act(() => void vi.advanceTimersByTime(8000));
    expect(result.current.prompt).toBeNull();
    expect(sceneRestartLogFields(ID)).toEqual({ sceneRestart: "proposé:ignoré" });
    expect(sent).toEqual([["debut-scene", expect.objectContaining({ itemId: ID, outcome: "ignoré", target: 98, back: 52, at: 150 })]]);
  });

  it("utilisé : le saut vers le point d'entrée, et pas « saut »", () => {
    config.data = { sceneRestartAvailable: true };
    const { result, rerender } = renderHook((p: Props) => useSceneRestart(p), { initialProps: base });
    rerender({ ...base, currentTime: 150, playing: true, settled: true });
    const seek = vi.fn(() => result.current.noteSeek());
    act(() => result.current.use(seek));
    expect(seek).toHaveBeenCalledWith(98);
    expect(sceneRestartLogFields(ID)).toEqual({ sceneRestart: "proposé:utilisé" });
    expect(sent.map(([, f]) => f.outcome)).toEqual(["utilisé"]);
  });

  it("un saut avant la première image refuse ; une reconstruction ne redemande rien", () => {
    config.data = { sceneRestartAvailable: true };
    const first = renderHook((p: Props) => useSceneRestart(p), { initialProps: base });
    act(() => first.result.current.noteSeek());
    first.rerender({ ...base, currentTime: 150, playing: true, settled: true });
    expect(sceneRestartLogFields(ID)).toEqual({ sceneRestart: "non:saut" });
    first.unmount();
    const again = renderHook((p: Props) => useSceneRestart(p), { initialProps: { ...base, currentTime: 150, playing: true, settled: true } });
    expect(again.result.current.prompt).toBeNull();
    expect(sceneRestartLogFields(ID)).toEqual({ sceneRestart: "non:saut" });
  });

  it("les scènes arrivées trop tard ne servent plus", () => {
    config.data = { sceneRestartAvailable: true };
    const { rerender } = renderHook((p: Props) => useSceneRestart(p), { initialProps: { ...base, payload: null } as Props });
    rerender({ ...base, payload: null, currentTime: 150, playing: true, settled: true });
    act(() => void vi.advanceTimersByTime(8000));
    rerender({ ...base, currentTime: 158, playing: true, settled: true });
    expect(sceneRestartLogFields(ID)).toEqual({ sceneRestart: "non:scènes-tardives" });
  });
});

describe("PlayerPrompts", () => {
  const props = {
    onSkip: () => {},
    sleepWarning: null,
    askStillThere: false,
    showNextUp: false,
    nextEpisode: null,
    nextUpCountdown: 10,
    requestAdvance: () => true,
    onDismissNextUp: () => {},
  };
  it("montre le bouton à la place de « Passer l'intro », qui garde la priorité", () => {
    const onSceneRestart = vi.fn();
    const { rerender } = render(<PlayerPrompts {...props} skipNow={null} sceneRestart={{ target: 98 }} onSceneRestart={onSceneRestart} />);
    fireEvent.click(screen.getByRole("button", { name: "player.sceneRestart" }));
    expect(onSceneRestart).toHaveBeenCalledTimes(1);
    rerender(<PlayerPrompts {...props} skipNow={{ kind: "intro", end: 60 }} sceneRestart={{ target: 98 }} onSceneRestart={onSceneRestart} />);
    expect(screen.queryByRole("button", { name: "player.sceneRestart" })).toBeNull();
    expect(screen.getByRole("button", { name: "player.skipIntro" })).toBeTruthy();
  });
});
