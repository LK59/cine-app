/**
 * Ce que le serveur et l'écran de réglage partagent de l'image des écrans de connexion (DECISIONS §199) —
 * sans `node:fs` : la carte de Configuration l'importe dans le navigateur.
 */

/** Ce que l'interface reçoit : l'adresse se construit avec `v`, et `dim` est l'opacité du voile, en %. */
export interface LoginBackground {
  v: string;
  dim: number;
}

/**
 * 9,5 Mo : sous les 10 Mo de corps que Next garde pour le proxy (`next.config.js`) — au-delà, le corps
 * arriverait tronqué. L'écran refuse avant l'envoi, la route sur la longueur annoncée.
 */
export const LOGIN_BACKGROUND_MAX_BYTES = 9.5 * 1024 * 1024;

export const LOGIN_BACKGROUND_DEFAULT_DIM = 55;
/** Le voile ne descend pas sous 20 % : sans lui, le texte blanc de la carte se perd sur une image claire. */
export const LOGIN_BACKGROUND_DIM_MIN = 20;
export const LOGIN_BACKGROUND_DIM_MAX = 85;

export function clampDim(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return LOGIN_BACKGROUND_DEFAULT_DIM;
  return Math.round(Math.min(LOGIN_BACKGROUND_DIM_MAX, Math.max(LOGIN_BACKGROUND_DIM_MIN, n)));
}
