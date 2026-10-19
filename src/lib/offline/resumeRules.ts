"use client";

/**
 * La règle de reprise de Jellyfin, appliquée sur l'appareil à une lecture hors ligne (Louis,
 * 19/10/2026) : sous le seuil minimum, pas de reprise ; au-delà du maximum, le titre est vu et la
 * position repart à zéro ; un titre plus court que la durée minimale ne garde jamais de position.
 * Les seuils sont ceux du serveur (`/api/player/resume-thresholds`), gardés sur l'appareil pour une
 * lecture sans réseau ; à défaut, ceux de Jellyfin par défaut. Avec du réseau, c'est Jellyfin
 * lui-même qui tranche : le lecteur hors ligne lui rapporte sa lecture comme le lecteur en ligne.
 */

export interface ResumeThresholds {
  min: number;
  max: number;
  minDurationSeconds: number;
}

const KEY = "cine:resume-thresholds";
const DEFAULTS: ResumeThresholds = { min: 5, max: 90, minDurationSeconds: 300 };

export function storedResumeThresholds(): ResumeThresholds {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as ResumeThresholds | null;
    if (saved && typeof saved.min === "number" && typeof saved.max === "number" && typeof saved.minDurationSeconds === "number") return saved;
  } catch {
    /* stockage indisponible */
  }
  return DEFAULTS;
}

/** Relit les seuils du serveur quand il y a du réseau ; sans effet sinon. */
export async function refreshResumeThresholds(): Promise<void> {
  try {
    const res = await fetch("/api/player/resume-thresholds", { cache: "no-store" });
    if (!res.ok) return;
    const value = (await res.json()) as ResumeThresholds;
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* hors ligne : on garde ce qu'on avait */
  }
}

/** Ce que Jellyfin retiendrait d'un arrêt à `seconds` : la position à garder, et si le titre est vu. */
export function applyResumeRules(seconds: number, runtimeSeconds: number, rules: ResumeThresholds = storedResumeThresholds()): { seconds: number; watched: boolean } {
  if (!(runtimeSeconds > 0)) return { seconds, watched: false };
  if (runtimeSeconds < rules.minDurationSeconds) return { seconds: 0, watched: false };
  const pct = (seconds / runtimeSeconds) * 100;
  if (pct >= rules.max) return { seconds: 0, watched: true };
  if (pct < rules.min) return { seconds: 0, watched: false };
  return { seconds, watched: false };
}
