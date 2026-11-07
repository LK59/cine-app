import { describe, it, expect } from "vitest";
import { noteReturn, watchReturns, RETURN_WINDOW_MS, type ReturnMeasure } from "@/lib/returnDiag";

/**
 * La mesure d'un retour au premier plan (07/11/2026, `returnDiag.ts`) : les images des trois secondes
 * qui suivent, et ce que les suspects ont fait pendant — rien après une absence courte.
 */
function setup() {
  let t = 0;
  let visibility: DocumentVisibilityState = "visible";
  const listeners = new Map<string, Array<() => void>>();
  const on = (type: string, fn: () => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  const off = (type: string, fn: () => void) => listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
  const fire = (type: string) => (listeners.get(type) ?? []).forEach((fn) => fn());
  let pending: ((t: number) => void) | null = null;
  const reports: ReturnMeasure[] = [];
  const doc = { get visibilityState() { return visibility; } } as unknown as Document;
  const win = { addEventListener: on, removeEventListener: off } as unknown as Window;
  const stop = watchReturns({
    doc,
    win,
    now: () => t,
    raf: (cb) => {
      pending = cb;
      return 1;
    },
    cancelRaf: () => {
      pending = null;
    },
    playing: () => false,
    report: (m) => reports.push(m),
  });
  return {
    reports,
    stop,
    hide: () => {
      visibility = "hidden";
      fire("visibilitychange");
    },
    show: () => {
      visibility = "visible";
      fire("visibilitychange");
    },
    pageHide: () => fire("pagehide"),
    advance: (ms: number) => {
      t += ms;
    },
    /** Une image dessinée `ms` après la précédente. */
    frame: (ms: number) => {
      t += ms;
      const cb = pending;
      pending = null;
      cb?.(t);
    },
  };
}

describe("watchReturns", () => {
  it("mesure les trois secondes après le retour, avec ce que les suspects ont noté", () => {
    const s = setup();
    s.hide();
    s.advance(60_000);
    s.show();
    s.frame(30); // première image
    noteReturn("version", "même");
    s.frame(16);
    s.frame(400); // le gel
    noteReturn("listes", 9);
    for (let elapsed = 446; elapsed < RETURN_WINDOW_MS + 20; elapsed += 17) s.frame(17);
    expect(s.reports).toHaveLength(1);
    const m = s.reports[0];
    expect(m).toMatchObject({ hiddenMs: 60_000, firstFrameMs: 30, maxGapMs: 400, maxGapAtMs: 446, janks: 1, longJanks: 1, film: false });
    expect(m.events).toEqual(["version:même@30", "listes:9@446"]);
    expect(m.cut).toBeUndefined();
    // Hors mesure : rien n'est noté nulle part.
    noteReturn("catalogue", "films-changé");
    expect(m.events).toHaveLength(2);
  });

  it("une absence de moins de deux secondes ne mesure rien", () => {
    const s = setup();
    s.hide();
    s.advance(1500);
    s.show();
    s.frame(16);
    s.frame(5000);
    expect(s.reports).toEqual([]);
  });

  it("une page qui se recharge pendant la mesure envoie ce qu'elle a", () => {
    const s = setup();
    s.hide();
    s.advance(10_000);
    s.show();
    s.frame(20);
    noteReturn("version", "rechargement");
    s.pageHide();
    expect(s.reports).toHaveLength(1);
    expect(s.reports[0]).toMatchObject({ cut: "rechargement", frames: 1, events: ["version:rechargement@20"] });
  });
});
