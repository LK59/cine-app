import { Vector2, type WebGLRenderer } from "three";
import { rendererName } from "../bench/bench";
import { isTouchDevice } from "./capability";
import { useStore } from "../state/store";

/**
 * Ce qu'« Auto » a fait pendant une visite (`world/AutoQuality.tsx`), en une ligne de `startup.log` envoyée quand la
 * page s'en va (`kind: "immersion-auto"`, route `/api/viewport-diag`) : le niveau de départ, d'arrivée, le pire et le
 * meilleur atteints, chaque changement (`secondes:de>vers` + `f` cadence trop basse, `a` à-coups, `m` marge pour
 * remonter), la cadence moyenne et les images de plus de 50 ms pendant qu'il décidait. Sans elle, rien ne disait si
 * « Auto » avait trouvé son niveau, ni en combien de temps, ni s'il hésitait.
 *
 * Une seule ligne par visite, et seulement si « Auto » a tourné : une page tuée par le système (iOS) n'envoie rien.
 */
const MAX_CHANGES = 40;
const CODE = { fps: "f", acoups: "a", marge: "m" } as const;

const visit = {
  gl: null as WebGLRenderer | null,
  /** La puce graphique, relevée à l'arrivée : en partant, le contexte est souvent déjà rendu (le journal disait « null »). */
  renderer: null as string | null,
  vendor: null as string | null,
  startedAt: 0,
  startLevel: 0,
  best: 0,
  worst: 0,
  changes: [] as string[],
  count: 0,
  frames: 0,
  ms: 0,
  over50: 0,
  sent: false,
};

export const autoLog = {
  start(level: number, gl: WebGLRenderer): void {
    if (visit.startedAt) return;
    Object.assign(visit, { gl, ...rendererName(gl), startedAt: performance.now(), startLevel: level, best: level, worst: level });
  },
  frame(ms: number): void {
    visit.frames += 1;
    visit.ms += ms;
    if (ms > 50) visit.over50 += 1;
  },
  change(from: number, to: number, why: keyof typeof CODE): void {
    if (from === to) return;
    visit.count += 1;
    visit.best = Math.min(visit.best, to);
    visit.worst = Math.max(visit.worst, to);
    if (visit.changes.length < MAX_CHANGES) visit.changes.push(`${Math.round((performance.now() - visit.startedAt) / 1000)}:${from}>${to}${CODE[why]}`);
  },
};

/** Envoie la ligne de la visite (une fois). Appelé à `pagehide` : `keepalive` la laisse partir avec la page. */
export function sendAutoLog(): void {
  if (visit.sent || !visit.startedAt || visit.frames === 0) return;
  visit.sent = true;
  const gl = visit.gl;
  const size = gl ? gl.getDrawingBufferSize(new Vector2()) : null;
  const { renderer, vendor } = visit;
  void fetch("/api/viewport-diag", {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "immersion-auto",
      startLevel: visit.startLevel,
      level: useStore.getState().autoLevel,
      best: visit.best,
      worst: visit.worst,
      count: visit.count,
      changes: visit.changes.join(";"),
      seconds: Math.round((performance.now() - visit.startedAt) / 1000),
      fps: visit.ms > 0 ? (visit.frames * 1000) / visit.ms : null,
      over50: visit.over50,
      renderer,
      vendor,
      width: size?.x ?? null,
      height: size?.y ?? null,
      dpr: window.devicePixelRatio || 1,
      touch: isTouchDevice(),
      build: __ASSETS_VERSION__,
    }),
  }).catch(() => undefined);
}
