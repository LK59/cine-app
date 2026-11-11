import { useFrame, useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { AUTO_LEVELS } from "../lib/settings";
import { useStore } from "../state/store";
import { autoLog } from "../lib/autoLog";
import { decide, freshMemory, SETTLE_MS, WINDOW } from "./autoDecision";

/**
 * « Auto » : la qualité suit la machine, dans les deux sens, aussi longtemps que dure la visite.
 *
 * Toutes les 250 ms, la cadence de la dernière tranche ; toutes les 2,5 s (dix tranches), une décision
 * (`autoDecision.ts`) : descendre d'un niveau (`AUTO_LEVELS` : la définition d'abord, puis les effets un à un) quand
 * la cadence est trop basse — **ou quand la fenêtre compte trois images de plus de 50 ms** : une cadence moyenne
 * honorable cachait des à-coups qui se voient (mesure du 11/11/2026 sur un portable en simple canal) ; remonter quand
 * il y a de la marge et aucune image de plus de 33 ms.
 *
 * Après chaque changement, 3 s sans rien décider (le nouveau niveau compile ses programmes : ce n'est pas sa
 * cadence). Les délais avant de remonter remplacent le gel définitif d'avant (`PerformanceMonitor` de drei,
 * `flipflops={4}` : au cinquième changement, Auto ne bougeait plus de la visite — ni pour descendre encore, ni pour
 * remonter quand la fenêtre changeait d'écran).
 *
 * Chaque changement est noté (`autoLog`) et part au journal en fin de visite (`immersion-auto`).
 */
const SAMPLE_MS = 250;

const run = { frames: 0, since: 0, samples: [] as number[], over33: 0, over50: 0, last: 0, quietUntil: 0, refresh: 0, memory: freshMemory() };

export function AutoQuality() {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    autoLog.start(useStore.getState().autoLevel, gl);
    run.quietUntil = performance.now() + SETTLE_MS;
  }, [gl]);

  useFrame(() => {
    const now = performance.now();
    const s = useStore.getState();
    const dt = run.last ? now - run.last : 0;
    run.last = now;
    const reset = () => {
      run.samples = [];
      run.since = 0;
      run.frames = 0;
      run.over33 = run.over50 = 0;
    };
    // Seulement dans le monde, en « Auto », hors mesure ; une image de plus d'une seconde est un onglet revenu de
    // l'arrière-plan, pas une lenteur ; et rien pendant le calme qui suit un changement.
    if (s.phase !== "world" || s.settings.quality !== "auto" || s.bench?.running || dt > 1000 || now < run.quietUntil) {
      reset();
      return;
    }
    autoLog.frame(dt);
    if (dt > 33) run.over33 += 1;
    if (dt > 50) run.over50 += 1;
    if (!run.since) run.since = now;
    run.frames += 1;
    if (now - run.since < SAMPLE_MS) return;
    const fps = (run.frames * 1000) / (now - run.since);
    run.frames = 0;
    run.since = now;
    run.refresh = Math.max(run.refresh, Math.min(240, fps));
    run.samples.push(fps);
    if (run.samples.length < WINDOW) return;
    const step = decide({ samples: run.samples, over33: run.over33, over50: run.over50, refresh: run.refresh }, s.autoLevel, AUTO_LEVELS.length - 1, now, run.memory);
    reset();
    if (!step) return;
    const from = s.autoLevel;
    s.stepAuto(step.to - from);
    run.quietUntil = now + SETTLE_MS;
    autoLog.change(from, useStore.getState().autoLevel, step.why);
  });
  return null;
}
