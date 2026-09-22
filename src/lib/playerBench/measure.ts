/**
 * Ce que le banc d'essai conclut d'une période de lecture — en fonctions pures, pour être testé.
 *
 * Une période est une suite d'échantillons pris tous les quarts de seconde : l'heure réelle,
 * l'horloge du film, les images présentées. Chaque panne que ce lecteur a connue se lit dans ces
 * trois courbes, et aucune autre mesure ne les a toutes vues :
 *
 * - l'horloge qui ne bouge plus alors que rien n'est en pause (1917 sur iPhone, 22/09/2026) ;
 * - l'horloge qui avance sans image (2012 sur iPhone, même jour : 658 images pour 55 s) ;
 * - l'horloge qui saute, en avant ou en arrière, sans que personne l'ait demandé ;
 * - l'horloge qui court plus vite ou plus lentement que le temps réel.
 */

export interface Sample {
  /** Millisecondes, horloge réelle. */
  wall: number;
  /** Secondes, horloge du film. */
  time: number;
  /** Images présentées depuis l'ouverture, ou `null` quand le navigateur ne le dit pas. */
  frames: number | null;
  paused: boolean;
  seeking: boolean;
}

export type Verdict = "ok" | "warn" | "fail";

export interface PlaybackReading {
  verdict: Verdict;
  /** Ce qui a été lu, en une phrase — vide quand tout va bien. */
  problems: string[];
  wallSeconds: number;
  clockSeconds: number;
  /** Images par seconde d'horloge, `null` sans compteur. */
  fps: number | null;
  /** La plus longue immobilité de l'horloge hors pause, en millisecondes. */
  longestFreezeMs: number;
  jumps: number;
}

/** Une immobilité plus courte ne se voit pas : un tampon qui se remplit, une image clé. */
const FREEZE_WARN_MS = 800;
const FREEZE_FAIL_MS = 2500;
/** Au-dessous, l'image ne suit plus l'horloge : c'est le « temps qui défile sans image ». */
const RUNAWAY_FPS = 8;
/** Entre deux échantillons, ce que l'horloge peut faire de plus que le temps réel. */
const JUMP_TOLERANCE_S = 0.6;

/**
 * Sous cette part de la cadence du fichier, l'image saccade : 18 images/s pour un film à 24 (banc
 * du 22/09/2026, 4K Dolby Vision sur un portable) se voyait à peine dans les chiffres.
 */
const JUDDER_RATIO = 0.85;

export function readPlayback(samples: Sample[], nominalFps: number | null = null): PlaybackReading {
  const empty: PlaybackReading = { verdict: "ok", problems: [], wallSeconds: 0, clockSeconds: 0, fps: null, longestFreezeMs: 0, jumps: 0 };
  if (samples.length < 2) return { ...empty, verdict: "warn", problems: ["trop peu d'échantillons"] };

  const first = samples[0];
  const last = samples[samples.length - 1];
  const wallSeconds = (last.wall - first.wall) / 1000;
  const problems: string[] = [];
  let failed = false;
  let warned = false;

  if (samples.every((s) => s.paused)) {
    return { ...empty, verdict: "fail", problems: ["resté en pause"], wallSeconds };
  }

  let clockSeconds = 0;
  let jumps = 0;
  let longestFreezeMs = 0;
  let freezeStart: number | null = null;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const wallDelta = (b.wall - a.wall) / 1000;
    const delta = b.time - a.time;
    if (delta > wallDelta + JUMP_TOLERANCE_S || delta < -0.25) {
      jumps += 1;
      problems.push(`saut non demandé de ${a.time.toFixed(1)} à ${b.time.toFixed(1)} s`);
    } else if (delta > 0) {
      clockSeconds += delta;
    }
    const still = Math.abs(delta) < 0.02 && !b.paused;
    if (still) {
      freezeStart ??= a.wall;
      longestFreezeMs = Math.max(longestFreezeMs, b.wall - freezeStart);
    } else {
      freezeStart = null;
    }
  }
  if (jumps > 0) failed = true;

  if (longestFreezeMs >= FREEZE_FAIL_MS) {
    failed = true;
    problems.push(`horloge immobile ${(longestFreezeMs / 1000).toFixed(1)} s`);
  } else if (longestFreezeMs >= FREEZE_WARN_MS) {
    warned = true;
    problems.push(`horloge immobile ${(longestFreezeMs / 1000).toFixed(1)} s`);
  }

  // Le rythme, sur ce qui a vraiment joué : la pause ne compte pas contre lui.
  const playingWall = samples.slice(1).reduce((sum, s, i) => sum + (s.paused ? 0 : (s.wall - samples[i].wall) / 1000), 0);
  if (playingWall > 2 && clockSeconds > playingWall * 1.25) {
    failed = true;
    problems.push(`horloge trop rapide : ${clockSeconds.toFixed(1)} s de film en ${playingWall.toFixed(1)} s`);
  }

  let fps: number | null = null;
  if (first.frames !== null && last.frames !== null && clockSeconds > 0.5) {
    fps = Math.max(0, last.frames - first.frames) / clockSeconds;
    if (clockSeconds >= 1.5 && fps < RUNAWAY_FPS) {
      failed = true;
      problems.push(`l'horloge avance sans image : ${fps.toFixed(1)} images/s`);
    } else if (nominalFps && clockSeconds >= 2.5 && fps < nominalFps * JUDDER_RATIO) {
      warned = true;
      problems.push(`saccades : ${fps.toFixed(0)} images/s pour ${nominalFps.toFixed(0)}`);
    }
  }

  return {
    verdict: failed ? "fail" : warned ? "warn" : "ok",
    problems,
    wallSeconds,
    clockSeconds,
    fps,
    longestFreezeMs,
    jumps,
  };
}

/** Le pire des deux. */
export function worst(a: Verdict, b: Verdict): Verdict {
  const rank = { ok: 0, warn: 1, fail: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}

/**
 * Des positions tirées au hasard, mais toujours les mêmes pour un même film : un défaut trouvé se
 * retrouve en relançant le banc. Un générateur à congruence, graine tirée de l'identifiant.
 */
export function seededPositions(seed: string, count: number, duration: number): number[] {
  let state = 0;
  for (let i = 0; i < seed.length; i++) state = (state * 31 + seed.charCodeAt(i)) >>> 0;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    // Entre 5 % et 90 % du film : ni l'ouverture, ni le générique.
    out.push(Math.round((0.05 + (state / 2 ** 32) * 0.85) * duration * 10) / 10);
  }
  return out;
}
