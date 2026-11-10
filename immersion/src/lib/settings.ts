/**
 * Les réglages du mode, gardés sur l'appareil.
 *
 * `localStorage` peut manquer ou refuser d'écrire (navigation privée, quota) : chaque accès est
 * gardé, et les réglages valent alors pour la visite seulement.
 */
export type Quality = "low" | "medium" | "high" | "ultra";
/** Le choix du visiteur : un préréglage, ou « Auto » — qui part d'Ultra et s'ajuste à la machine. */
export type QualityChoice = Quality | "auto";

export interface Settings {
  quality: QualityChoice;
  /**
   * Suréchantillonnage : rendre au-delà de la résolution native de l'écran (× 1,5). Hors préréglages,
   * coupé par défaut — c'est un luxe pour une carte graphique qui a de la marge.
   */
  supersampling: boolean;
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
  /** Mode cinéma : quand un film joue, les lampes baissent d'elles-mêmes et l'écran éclaire la pièce. */
  cinema: boolean;
  /**
   * Conversion HDR → SDR par le serveur, pour les fichiers HDR seulement (HDR10, HDR10+, HLG, Dolby
   * Vision) : dans une texture WebGL, une image HDR sort délavée. Activée par défaut ; la couper garde
   * l'image d'origine et épargne un transcodage au serveur. Un fichier SDR n'est jamais concerné.
   */
  hdrToSdr: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  quality: "auto",
  supersampling: false,
  volume: 0.8,
  spatial: true,
  reverb: 0.35,
  sensitivity: 1,
  fov: 68,
  showFps: false,
  cinema: true,
  hdrToSdr: true,
};

/** Ce que coûte un niveau de qualité. Une seule table, lue par le rendu, la neige et les ombres. */
export interface QualityProfile {
  /**
   * L'échelle de résolution, en fraction de la résolution **native** de l'écran (1 = un pixel rendu
   * par pixel affiché). Jamais au-dessus de 1 ici : au-delà, c'est le suréchantillonnage, à part.
   */
  scale: number;
  /** Taille des cartes d'ombre ; 0 = aucune ombre temps réel. */
  shadowMap: number;
  /** Occlusion ambiante en espace écran : aucune, légère (peu d'échantillons), pleine. */
  ao: "none" | "light" | "full";
  bloom: boolean;
  smaa: boolean;
  /** Nombre de flocons. */
  snow: number;
  /** Lumières ponctuelles d'appoint (les lampes au-delà du lustre) et lumière de l'écran. */
  fillLights: boolean;
  /** Filtrage anisotrope des textures. */
  anisotropy: number;
}

/**
 * Les préréglages. **Ultra est la cible** : tous les effets, à la résolution native — c'est lui qui
 * doit tenir 60 images par seconde sur un processeur graphique intégré récent (Intel Arc). Les trois
 * autres sont pour les machines en dessous.
 */
export const QUALITY: Record<Quality, QualityProfile> = {
  low: { scale: 0.6, shadowMap: 0, ao: "none", bloom: false, smaa: false, snow: 1500, fillLights: false, anisotropy: 2 },
  medium: { scale: 0.75, shadowMap: 1024, ao: "none", bloom: true, smaa: true, snow: 4000, fillLights: true, anisotropy: 4 },
  high: { scale: 0.9, shadowMap: 2048, ao: "none", bloom: true, smaa: true, snow: 8000, fillLights: true, anisotropy: 8 },
  ultra: { scale: 1, shadowMap: 2048, ao: "light", bloom: true, smaa: true, snow: 16000, fillLights: true, anisotropy: 16 },
};

/**
 * « Auto » : une échelle de niveaux qui part d'Ultra. Quand les images tardent, la résolution interne
 * baisse d'abord — c'est ce qui se voit le moins —, puis les effets coûteux tombent un par un : l'
 * occlusion, la finesse des ombres, les lumières d'appoint, le halo, l'anticrénelage. Quand la machine
 * a de la marge, on remonte.
 */
export const AUTO_LEVELS: QualityProfile[] = [
  QUALITY.ultra,
  { ...QUALITY.ultra, scale: 0.9 },
  { ...QUALITY.ultra, scale: 0.8 },
  { ...QUALITY.ultra, scale: 0.8, ao: "none" },
  { ...QUALITY.ultra, scale: 0.7, ao: "none", snow: 8000 },
  { ...QUALITY.ultra, scale: 0.7, ao: "none", snow: 8000, shadowMap: 1024, anisotropy: 8 },
  { ...QUALITY.ultra, scale: 0.65, ao: "none", snow: 4000, shadowMap: 1024, anisotropy: 4, fillLights: false },
  { ...QUALITY.ultra, scale: 0.6, ao: "none", snow: 4000, shadowMap: 1024, anisotropy: 4, fillLights: false, bloom: false },
  { ...QUALITY.low, scale: 0.55 },
];

/** Ce que le suréchantillonnage ajoute à l'échelle du préréglage. */
export const SUPERSAMPLING = 1.5;

/** Le profil en vigueur : celui du préréglage choisi, ou le niveau courant d'« Auto ». */
export function profileOf(quality: QualityChoice, autoLevel: number): QualityProfile {
  return quality === "auto" ? AUTO_LEVELS[Math.max(0, Math.min(AUTO_LEVELS.length - 1, autoLevel))] : QUALITY[quality];
}

const KEY = "laterna:immersion:settings:v2";

const clamp = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/** Ne garde d'un objet lu que ce qui a la bonne forme : un réglage d'une version future ou abîmé retombe sur le défaut. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  return {
    quality: r.quality === "auto" || r.quality === "low" || r.quality === "medium" || r.quality === "high" || r.quality === "ultra" ? r.quality : d.quality,
    supersampling: typeof r.supersampling === "boolean" ? r.supersampling : d.supersampling,
    volume: clamp(r.volume, 0, 1, d.volume),
    spatial: typeof r.spatial === "boolean" ? r.spatial : d.spatial,
    reverb: clamp(r.reverb, 0, 1, d.reverb),
    sensitivity: clamp(r.sensitivity, 0.2, 3, d.sensitivity),
    fov: clamp(r.fov, 50, 100, d.fov),
    showFps: typeof r.showFps === "boolean" ? r.showFps : d.showFps,
    cinema: typeof r.cinema === "boolean" ? r.cinema : d.cinema,
    hdrToSdr: typeof r.hdrToSdr === "boolean" ? r.hdrToSdr : d.hdrToSdr,
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
