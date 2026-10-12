// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { installRemoteDiag, isFireTv } from "@/lib/fireTv";

const SILK = "Mozilla/5.0 (Linux; Android 11; AFTT) AppleWebKit/537.36 (KHTML, like Gecko) Silk/152.4.7 like Chrome/152.0.7977.140 Safari/537.36";
const PIXEL = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";

describe("isFireTv", () => {
  it("reconnaît la Fire TV Stick de Timothé, pas un téléphone Android", () => {
    expect(isFireTv(SILK)).toBe(true);
    expect(isFireTv(PIXEL)).toBe(false);
  });
});

describe("installRemoteDiag", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function trustedKey(key: string, keyCode: number): KeyboardEvent {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    Object.defineProperty(e, "keyCode", { value: keyCode });
    return e;
  }

  it("relève les touches telles qu'elles arrivent, en mode « spatial »", () => {
    const send = vi.fn();
    const remove = installRemoteDiag(window, send);
    document.body.dispatchEvent(trustedKey("ArrowDown", 40));
    document.body.dispatchEvent(trustedKey("", 13));
    vi.advanceTimersByTime(90_000);
    expect(send).toHaveBeenCalledTimes(1);
    const body = send.mock.calls[0][0] as { mode: string; keys: { key: string; keyCode: number }[] };
    expect(body.mode).toBe("spatial");
    expect(body.keys.map((k) => [k.key, k.keyCode])).toEqual([
      ["ArrowDown", 40],
      ["", 13],
    ]);
    remove();
  });

  /**
   * Le seul relevé de Timothé était celui du curseur (`keys: []`) : envoyé une fois par onglet, il
   * empêchait d'observer le mode immersif, celui qui ne marchait pas.
   */
  it("un relevé par mode : le curseur d'abord, puis les touches en ouvrent un second", () => {
    const send = vi.fn();
    const remove = installRemoteDiag(window, send);
    for (let i = 0; i < 5; i++) window.dispatchEvent(new MouseEvent("pointermove", { clientX: 10 + i, clientY: 10 }));
    document.body.dispatchEvent(trustedKey("ArrowLeft", 37));
    // La touche a clos le relevé du curseur.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ mode: "curseur", keys: [], pointerMoves: 5, report: 1 });
    vi.advanceTimersByTime(90_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toMatchObject({ mode: "spatial", report: 2 });
    remove();
  });

  it("vingt mouvements de curseur sans touche closent le relevé spatial", () => {
    const send = vi.fn();
    const remove = installRemoteDiag(window, send);
    document.body.dispatchEvent(trustedKey("ArrowRight", 39));
    for (let i = 0; i < 25; i++) window.dispatchEvent(new MouseEvent("pointermove", { clientX: 100 + i, clientY: 10 }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ mode: "spatial" });
    vi.advanceTimersByTime(90_000);
    expect(send.mock.calls[1][0]).toMatchObject({ mode: "curseur" });
    remove();
  });

  it("borné : trois relevés par onglet au plus, deux du même mode, et l'onglet s'en souvient", () => {
    const send = vi.fn();
    const remove = installRemoteDiag(window, send);
    for (let round = 0; round < 4; round++) {
      document.body.dispatchEvent(trustedKey("ArrowDown", 40));
      vi.advanceTimersByTime(90_000);
    }
    // Deux relevés « spatial », pas plus.
    expect(send).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 1, clientY: 1 }));
    vi.advanceTimersByTime(90_000);
    expect(send).toHaveBeenCalledTimes(3);
    remove();
    // Un nouveau chargement du même onglet : plus rien.
    const again = vi.fn();
    const removeAgain = installRemoteDiag(window, again);
    document.body.dispatchEvent(trustedKey("ArrowDown", 40));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 5, clientY: 5 }));
    vi.advanceTimersByTime(90_000);
    expect(again).not.toHaveBeenCalled();
    removeAgain();
  });

  it("dit le focus avant et après chaque touche, et si la grille l'a déplacé", () => {
    const a = document.createElement("button");
    a.setAttribute("data-tv-card", "");
    a.dataset.tvRow = "genre-Drame";
    a.dataset.tvCol = "3";
    const b = document.createElement("button");
    b.setAttribute("data-tv-card", "");
    b.dataset.tvRow = "genre-Drame";
    b.dataset.tvCol = "4";
    document.body.append(a, b);
    let moves = 0;
    const send = vi.fn();
    const remove = installRemoteDiag(window, send, () => moves);
    a.focus();
    // La grille sert la flèche : elle déplace le focus et le compte.
    const onGrid = (e: KeyboardEvent) => {
      if (e.key !== "ArrowRight") return;
      moves += 1;
      b.focus();
    };
    window.addEventListener("keydown", onGrid);
    a.dispatchEvent(trustedKey("ArrowRight", 39));
    window.removeEventListener("keydown", onGrid);
    // Personne ne sert celle-ci.
    b.dispatchEvent(trustedKey("ArrowUp", 38));
    vi.advanceTimersByTime(90_000);
    const keys = (send.mock.calls[0][0] as { keys: { before: string; after: string; gridMoved: boolean }[] }).keys;
    expect(keys[0]).toMatchObject({ before: "button[carte genre-Drame#3]", after: "button[carte genre-Drame#4]", gridMoved: true });
    expect(keys[1]).toMatchObject({ before: "button[carte genre-Drame#4]", after: "button[carte genre-Drame#4]", gridMoved: false });
    remove();
    a.remove();
    b.remove();
  });

  it("relève un focus déplacé sans touche ni appui — la navigation spatiale qui garde la flèche", () => {
    const a = document.createElement("button");
    a.setAttribute("data-tv-card", "");
    a.dataset.tvRow = "top10";
    a.dataset.tvCol = "0";
    const b = document.createElement("button");
    b.setAttribute("data-tv-card", "");
    b.dataset.tvRow = "top10";
    b.dataset.tvCol = "1";
    document.body.append(a, b);
    a.focus();
    const send = vi.fn();
    const remove = installRemoteDiag(window, send);
    b.focus();
    vi.advanceTimersByTime(90_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      mode: "spatial",
      keys: [],
      focusMoves: [expect.objectContaining({ from: "button[carte top10#0]", to: "button[carte top10#1]" })],
    });
    remove();
    a.remove();
    b.remove();
  });

  it("n'envoie rien s'il ne s'est rien passé", () => {
    const send = vi.fn();
    installRemoteDiag(window, send);
    vi.advanceTimersByTime(90_000);
    expect(send).not.toHaveBeenCalled();
  });
});
