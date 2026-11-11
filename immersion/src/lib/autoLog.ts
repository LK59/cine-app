import { Vector2, type WebGLRenderer } from "three";
import { rendererName } from "../bench/bench";
import { isTouchDevice } from "./capability";
import { visitErrors } from "./errorLog";
import { useStore, type Phase } from "../state/store";

/**
 * La ligne de la visite, envoyée quand la page s'en va (`kind: "immersion-auto"`, route `/api/viewport-diag`, dans
 * `startup.log`) : la qualité choisie, la phase atteinte et celle du départ, la durée, les erreurs et les pertes du
 * contexte WebGL (`errorLog.ts`), la puce graphique et la définition rendue — et, quand « Auto » a tourné
 * (`world/AutoQuality.tsx`), ce qu'il a fait : le niveau de départ, d'arrivée, le pire et le meilleur atteints, chaque
 * changement (`secondes:de>vers` + `f` cadence trop basse, `a` à-coups, `m` marge pour remonter), la cadence moyenne et
 * les images de plus de 50 ms pendant qu'il décidait. Sans elle, rien ne disait si « Auto » avait trouvé son niveau,
 * ni en combien de temps, ni s'il hésitait.
 *
 * Jusqu'en 10.37.3 la ligne n'existait que sous « Auto », et seulement si des images avaient été comptées : une visite
 * sous un préréglage choisi, ou arrêtée au chargement, ne laissait rien. Elle part maintenant à chaque visite (les
 * champs d'« Auto » à `null` quand il n'a pas tourné, `auto: false`). Le nom du `kind` est resté pour ne pas couper la
 * suite des lignes déjà écrites.
 *
 * Les secondes (`seconds`, et celles de chaque changement) comptent depuis l'ouverture de la page.
 * Une seule ligne par visite ; une page tuée par le système (iOS) n'envoie rien.
 */
const MAX_CHANGES = 40;
const CODE = { fps: "f", acoups: "a", marge: "m" } as const;

/** Les phases dans l'ordre où une visite les traverse : la ligne dit la plus avancée atteinte. */
const PROGRESS: readonly Phase[] = ["checking", "unsupported", "loading", "gate", "world"];
let reached: Phase = "checking";
useStore.subscribe((s) => {
  if (PROGRESS.indexOf(s.phase) > PROGRESS.indexOf(reached)) reached = s.phase;
});

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
  /** Le monde est monté (appelé par `AutoQuality`, sous tout préréglage) : la puce graphique est relevée maintenant. */
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
    if (visit.changes.length < MAX_CHANGES) visit.changes.push(`${Math.round(performance.now() / 1000)}:${from}>${to}${CODE[why]}`);
  },
};

/** Envoie la ligne de la visite (une fois). Appelé à `pagehide` : `keepalive` la laisse partir avec la page. */
export function sendAutoLog(): void {
  if (visit.sent) return;
  visit.sent = true;
  try {
    const state = useStore.getState();
    const gl = visit.gl;
    // Un contexte déjà rendu peut lever ici : la ligne part quand même, sans la définition.
    let size: Vector2 | null = null;
    try {
      size = gl ? gl.getDrawingBufferSize(new Vector2()) : null;
    } catch {
      size = null;
    }
    // « Auto » a tourné s'il a compté des images (sous un préréglage choisi, ou sans monde, il n'en compte aucune).
    const auto = visit.frames > 0;
    const { renderer, vendor } = visit;
    void fetch("/api/viewport-diag", {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "immersion-auto",
        quality: state.settings.quality,
        phase: reached,
        end: state.phase,
        seconds: Math.round(performance.now() / 1000),
        errors: visitErrors.errors,
        contextLost: visitErrors.contextLost,
        auto,
        startLevel: auto ? visit.startLevel : null,
        level: auto ? state.autoLevel : null,
        best: auto ? visit.best : null,
        worst: auto ? visit.worst : null,
        count: auto ? visit.count : null,
        changes: auto ? visit.changes.join(";") : null,
        fps: auto && visit.ms > 0 ? (visit.frames * 1000) / visit.ms : null,
        over50: auto ? visit.over50 : null,
        renderer,
        vendor,
        width: size?.x ?? null,
        height: size?.y ?? null,
        dpr: window.devicePixelRatio || 1,
        touch: isTouchDevice(),
        build: __ASSETS_VERSION__,
      }),
    }).catch(() => undefined);
  } catch {
    // La ligne de la visite ne doit jamais devenir l'erreur de la page qui s'en va.
  }
}
