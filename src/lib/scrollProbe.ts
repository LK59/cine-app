"use client";

import { useEffect, useSyncExternalStore, type RefObject } from "react";
import { reportPlayback } from "@/lib/reportPlayback";

/**
 * La mesure de fluidité de la grille (Lab → Tests divers → Fluidité, 13/10/2026).
 *
 * L'à-coup de « Tous les films » en atteignant le haut ne se reproduit ni dans WebKit sous
 * Playwright ni par la lecture du code, et quatre suspects ont été écartés à l'œil sur l'iPhone.
 * Armée depuis le Lab, la mesure attend le premier défilement de la grille, relève chaque image
 * pendant 20 s (durée, position, sens, cartes que Safari vient de dessiner ou de mettre de côté
 * via `contentvisibilityautostatechange`), puis envoie UNE ligne `fluidite` au journal et se
 * désarme. Rien ne tourne sans elle.
 */
const ARMED_KEY = "cine:lab:probe";
const DURATION_MS = 20_000;
/** Une image de plus de 25 ms, à 60 Hz, en a sauté au moins une. */
const LONG_FRAME_MS = 25;

const listeners = new Set<() => void>();
let state: "off" | "armed" | "recording" | "sent" = "off";

function readArmed(): boolean {
  try {
    return localStorage.getItem(ARMED_KEY) === "1";
  } catch {
    return false;
  }
}

function setState(next: typeof state): void {
  state = next;
  try {
    if (next === "armed") localStorage.setItem(ARMED_KEY, "1");
    else localStorage.removeItem(ARMED_KEY);
  } catch {
    /* la mesure vaut pour cette page */
  }
  for (const listener of listeners) listener();
}

export function armScrollProbe(): void {
  setState("armed");
}

export function disarmScrollProbe(): void {
  setState("off");
}

export function useScrollProbeState(): typeof state {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (state === "off" && readArmed() ? "armed" : state),
    () => "off"
  );
}

function scrollingAncestor(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/** Branchée sur une grille : enregistre si la mesure est armée, sinon ne fait rien. */
export function useScrollProbe(grid: RefObject<HTMLElement | null>, label: string, items: number): void {
  useEffect(() => {
    if (!(state === "armed" || (state === "off" && readArmed()))) return;
    const root = grid.current;
    const scroller = root ? scrollingAncestor(root) : null;
    if (!root || !scroller) return;

    type Frame = { t: number; dt: number; top: number; shown: number; skipped: number; scrolls: number };
    const frames: Frame[] = [];
    let shown = 0;
    let skipped = 0;
    let scrolls = 0;
    let started = 0;
    let raf = 0;
    let last = 0;
    let done = false;

    const onVisibility = (e: Event) => {
      if ((e as Event & { skipped?: boolean }).skipped) skipped++;
      else shown++;
    };
    const tick = (now: number) => {
      if (done) return;
      frames.push({ t: Math.round(now - started), dt: Math.round(now - last), top: Math.round(scroller.scrollTop), shown, skipped, scrolls });
      shown = 0;
      skipped = 0;
      scrolls = 0;
      last = now;
      if (now - started >= DURATION_MS) return finish();
      raf = requestAnimationFrame(tick);
    };
    const onScroll = () => {
      scrolls++;
      if (started) return;
      started = performance.now();
      last = started;
      setState("recording");
      raf = requestAnimationFrame(tick);
    };
    const finish = () => {
      if (done) return;
      done = true;
      cleanupListeners();
      const long = frames.filter((f) => f.dt > LONG_FRAME_MS);
      // Chaque image longue avec les deux qui la précèdent : position, sens, cartes rendues ou
      // mises de côté juste avant — le contexte de l'à-coup.
      const detail = long
        .slice(0, 40)
        .map((f) => {
          const i = frames.indexOf(f);
          const before = frames.slice(Math.max(0, i - 2), i);
          const dir = before.length ? Math.sign(f.top - before[before.length - 1].top) : 0;
          const ctx = before.map((b) => `${b.top}/${b.shown}+${b.skipped}-`).join(" ");
          return `${f.t}ms dt${f.dt} top${f.top} dir${dir} +${f.shown}/-${f.skipped} sc${f.scrolls} | ${ctx}`;
        })
        .join(" ; ");
      const dts = frames.map((f) => f.dt).sort((a, b) => a - b);
      reportPlayback("fluidite", {
        probe: label,
        items,
        frames: frames.length,
        longFrames: long.length,
        worstMs: dts[dts.length - 1] ?? 0,
        p95Ms: dts[Math.floor(dts.length * 0.95)] ?? 0,
        minTop: Math.min(...frames.map((f) => f.top)),
        cvEvents: typeof document !== "undefined" && "oncontentvisibilityautostatechange" in document.body ? "oui" : "non",
        steps: detail,
      });
      setState("sent");
    };
    const cleanupListeners = () => {
      cancelAnimationFrame(raf);
      scroller.removeEventListener("scroll", onScroll);
      root.removeEventListener("contentvisibilityautostatechange", onVisibility, true);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    root.addEventListener("contentvisibilityautostatechange", onVisibility, true);
    return () => {
      // Quitter la grille pendant l'enregistrement envoie ce qui a été relevé.
      if (started && !done) finish();
      else cleanupListeners();
    };
  }, [grid, label, items]);
}
