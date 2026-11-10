/**
 * Les réglages du mode, gardés sur l'appareil.
 *
 * `localStorage` peut manquer ou refuser d'écrire (navigation privée, quota) : chaque accès est
 * gardé, et les réglages valent alors pour la visite seulement.
 */
export type Quality = "low" | "medium" | "high" | "ultra";

export interface Settings {
  quality: Quality;
  /** 0 à 1. */
  volume: number;
  /** Le son du film sort-il de la télévision (vrai), ou directement dans le casque (faux) ? */
  spatial: boolean;
  /** 0 à 1 : la part de réverbération de la pièce. */
  reverb: number;
  /** Multiplicateur de la vitesse du regard. */
  sensitivity: number;
  /** Champ de vision vertical, en degrés. */
  fov: number;
  showFps: boolean;
  /** Demander à Jellyfin une image SDR (transcodage avec mappage de tons) — voir `media/negotiate.ts`. */
  forceSdr: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  quality: "medium",
  volume: 0.8,
  spatial: true,
  reverb: 0.35,
  sensitivity: 1,
  fov: 68,
  showFps: false,
  forceSdr: false,
};

/** Ce que coûte chaque préréglage. Une seule table, lue par le rendu, la neige et les ombres. */
export interface QualityProfile {
  /** Bornes de l'échelle de résolution (DPR) entre lesquelles le moniteur de performance ajuste. */
  dpr: [number, number];
  /** Taille des cartes d'ombre ; 0 = aucune ombre temps réel. */
  shadowMap: number;
  /** Occlusion ambiante en espace écran : aucune, légère (peu d'échantillons), pleine. */
  ao: "none" | "light" | "full";
  bloom: boolean;
  smaa: boolean;
  /** Nombre de flocons. */
  snow: number;
  /** Lumières ponctuelles d'appoint (les lampes au-delà du lustre). */
  fillLights: boolean;
  /** Filtrage anisotrope des textures. */
  anisotropy: number;
}

export const QUALITY: Record<Quality, QualityProfile> = {
  low: { dpr: [0.6, 0.85], shadowMap: 0, ao: "none", bloom: false, smaa: false, snow: 1500, fillLights: false, anisotropy: 2 },
  medium: { dpr: [0.75, 1], shadowMap: 1024, ao: "none", bloom: true, smaa: true, snow: 4000, fillLights: true, anisotropy: 4 },
  high: { dpr: [0.9, 1.25], shadowMap: 2048, ao: "light", bloom: true, smaa: true, snow: 8000, fillLights: true, anisotropy: 8 },
  ultra: { dpr: [1, 2], shadowMap: 4096, ao: "full", bloom: true, smaa: true, snow: 16000, fillLights: true, anisotropy: 16 },
};

const KEY = "laterna:immersion:settings:v1";

const clamp = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/** Ne garde d'un objet lu que ce qui a la bonne forme : un réglage d'une version future ou abîmé retombe sur le défaut. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  return {
    quality: r.quality === "low" || r.quality === "medium" || r.quality === "high" || r.quality === "ultra" ? r.quality : d.quality,
    volume: clamp(r.volume, 0, 1, d.volume),
    spatial: typeof r.spatial === "boolean" ? r.spatial : d.spatial,
    reverb: clamp(r.reverb, 0, 1, d.reverb),
    sensitivity: clamp(r.sensitivity, 0.2, 3, d.sensitivity),
    fov: clamp(r.fov, 50, 100, d.fov),
    showFps: typeof r.showFps === "boolean" ? r.showFps : d.showFps,
    forceSdr: typeof r.forceSdr === "boolean" ? r.forceSdr : d.forceSdr,
  };
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return sanitizeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Stockage indisponible : les réglages valent pour cette visite.
  }
}
