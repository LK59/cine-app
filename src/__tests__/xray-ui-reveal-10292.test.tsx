// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, renderHook, cleanup, act, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 10.29.2 — deux défauts vus pendant un passage du banc de bout en bout (09/11/2026) :
 * - les lignes `row` du relevé `xray-ui` disaient `rowOpacity: 1` alors que tout le cadre du lecteur était à
 *   l'opacité 0 (l'accueil à l'écran) : `effectiveLookOf` multiplie les opacités jusqu'à la racine, dit ce qui cache
 *   plus haut, et `hitAt` dit ce qui est vraiment dessus au centre de la rangée et de sa première pilule ;
 * - le lecteur restait invisible tant qu'une image (`requestAnimationFrame`) ne posait pas `revealed` — 2,6 à 9,3 s
 *   sous charge chez WebKit : `useRevealAfterFrame` le montre au bout de `REVEAL_FALLBACK_MS` quand même.
 */

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  useLocale: () => ({ locale: "fr" }),
}));

import { effectiveLookOf } from "@/lib/xrayUiDiag";
import { PlayerOnScreen } from "@/components/playerControls/PlayerOnScreen";
import { REVEAL_FALLBACK_MS, useRevealAfterFrame } from "@/lib/useRevealAfterFrame";
import { nativeFrameStyle } from "@/components/playerNative/nativeFrameStyle";
import type { XrayPlayerPerson } from "@/lib/xray/scenes";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "elementFromPoint");
});

const person = (personId: number, name: string, character: string, screenTime: number): XrayPlayerPerson => ({ personId, name, character, photo: null, screenTime, confidence: 0.9 });
const TWO = [person(1, "Jason Sudeikis", "Ted Lasso", 50), person(2, "Brett Goldstein", "Roy Kent", 40)];

describe("`effectiveLookOf` : ce que l'écran montre vraiment", () => {
  it("le produit des opacités jusqu'à la racine ; `display: none` ou `visibility: hidden` plus haut se disent", () => {
    const outer = document.createElement("div");
    const mid = document.createElement("div");
    const el = document.createElement("span");
    outer.append(mid);
    mid.append(el);
    document.body.append(outer);
    outer.style.opacity = "0.5";
    mid.style.opacity = "0.5";
    expect(effectiveLookOf(el)).toEqual({ effOpacity: 0.25, hiddenBy: null });
    outer.style.opacity = "0";
    expect(effectiveLookOf(el).effOpacity).toBe(0);
    outer.style.opacity = "";
    mid.style.visibility = "hidden";
    expect(effectiveLookOf(el).hiddenBy).toBe("visibility");
    outer.style.display = "none";
    expect(effectiveLookOf(el).hiddenBy).toBe("display");
    expect(effectiveLookOf(null)).toEqual({ effOpacity: null, hiddenBy: null });
    outer.remove();
  });

  it("la ligne `row` : l'opacité propre à 1, l'effective à 0 sous un cadre invisible ; ce qui est dessus au centre", async () => {
    const lines: Record<string, unknown>[] = [];
    const diag = (event: string, fields: Record<string, unknown>) => void lines.push({ event, ...fields });
    let hit: Element | null = null;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => hit });
    const { container } = render(
      <div data-frame="" style={{ opacity: 0 }}>
        <PlayerOnScreen people={TWO} visible onPick={() => {}} diag={diag} />
      </div>
    );
    // Au centre de la première pilule : elle-même — dans la rangée aussi.
    hit = container.querySelector('[data-onscreen-person="1"]');
    await waitFor(() => expect(lines.some((l) => l.event === "row")).toBe(true));
    const row = lines.find((l) => l.event === "row")!;
    expect(row).toMatchObject({ rowOpacity: 1, rowEffOpacity: 0, firstOpacity: 1, firstEffOpacity: 0, firstTop: "elle" });
    expect(row.rowTop).toBe("elle");
  });

  it("un autre élément au-dessus (l'accueil sous un cadre invisible) : nommé, pas « elle »", async () => {
    const lines: Record<string, unknown>[] = [];
    const diag = (event: string, fields: Record<string, unknown>) => void lines.push({ event, ...fields });
    const home = document.createElement("main");
    home.setAttribute("data-home", "");
    document.body.append(home);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => home });
    render(<PlayerOnScreen people={TWO} visible onPick={() => {}} diag={diag} />);
    await waitFor(() => expect(lines.some((l) => l.event === "row")).toBe(true));
    expect(lines.find((l) => l.event === "row")).toMatchObject({ rowTop: "main[data-home]", firstTop: "main[data-home]", rowEffOpacity: 1 });
    home.remove();
  });
});

describe("`useRevealAfterFrame` : le filet de l'arrivée du lecteur", () => {
  it("l'image vient d'abord (le cas ordinaire) : montré à l'image, le minuteur annulé — rien d'autre ne reste en attente", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    const { result } = renderHook(() => useRevealAfterFrame());
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(16));
    expect(result.current).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it(`aucune image (WebKit sous charge) : montré quand même au bout de ${REVEAL_FALLBACK_MS} ms, pas avant`, () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Une image qui ne vient jamais.
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const { result } = renderHook(() => useRevealAfterFrame());
    act(() => void vi.advanceTimersByTime(REVEAL_FALLBACK_MS - 1));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("refermé avant : le minuteur et l'image annulés au démontage — rien ne montre un lecteur parti", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", () => 7);
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const { unmount } = renderHook(() => useRevealAfterFrame());
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it("un lecteur qui se referme reste invisible même montré : `revealed` ne l'emporte jamais sur `closing`", () => {
    const base = { isMini: false, pos: { x: 0, y: 0 }, size: { width: 0, height: 0 }, isDragging: false, resizing: false };
    expect(nativeFrameStyle({ ...base, revealed: true, closing: true }).opacity).toBe(0);
    expect(nativeFrameStyle({ ...base, revealed: true, closing: false }).opacity).toBe(1);
  });

  it("les deux lecteurs (en ligne et hors ligne) passent par lui ; plus aucun `setRevealed` à la main", () => {
    for (const file of ["src/components/ExperimentalPlayerHost.tsx", "src/components/offline/OfflinePlayerHost.tsx"]) {
      const src = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(src, file).toContain("useRevealAfterFrame()");
      expect(src, file).not.toContain("setRevealed");
    }
  });
});
