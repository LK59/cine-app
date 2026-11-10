import { BREAST, CHANDELIER, TABLE } from "./layout";

/** Une bougie : le pied de sa cire, sa hauteur, son rayon. La flamme se pose au-dessus. */
export interface Candle {
  p: [number, number, number];
  h: number;
  r: number;
}

function ring(radius: number, y: number, count: number, phase: number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const a = phase + (i / count) * Math.PI * 2;
    return { p: [CHANDELIER.x + Math.cos(a) * radius, y, CHANDELIER.z + Math.sin(a) * radius] as [number, number, number], h: 0.2, r: 0.042 };
  });
}

/**
 * Toutes les bougies du salon, en une liste : celles du lustre (deux anneaux), du manteau, du banc
 * de l'âtre et de la table basse. Un seul maillage instancié pour la cire, un seul nuage de points
 * pour les flammes — voir `Candles`.
 */
export const CANDLES: Candle[] = [
  ...ring(CHANDELIER.r1, CHANDELIER.y + 0.06, 16, 0.2),
  ...ring(CHANDELIER.r2, CHANDELIER.y + CHANDELIER.rise + 0.06, 10, 0.5),
  // Sur le manteau, de part et d'autre de l'écran.
  ...[-3.75, -3.45, -3.2, 0.2, 0.48, 0.74].map((z, i) => ({ p: [BREAST.face - 0.2, 1.0, z] as [number, number, number], h: [0.3, 0.2, 0.26, 0.24, 0.32, 0.18][i], r: 0.05 })),
  // Sur le banc de l'âtre.
  ...[-4.15, -3.9, 1.0, 1.25].map((z, i) => ({ p: [BREAST.face - 0.3 - (i % 2) * 0.12, 0.44, z] as [number, number, number], h: [0.34, 0.24, 0.28, 0.4][i], r: 0.06 })),
  // Sur la table basse, sous sa cloche de verre.
  { p: [TABLE.x + 0.1, TABLE.h + 0.035, TABLE.z + 0.02], h: 0.22, r: 0.055 },
];
