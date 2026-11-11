/**
 * Les positions des autres participants, hors de React : elles arrivent une dizaine de fois par seconde par
 * personne, et les avatars (`world/Others.tsx`) les lisent à chaque image. Les écrire dans le store redessinerait
 * l'interface pour rien.
 *
 * Chaque arrivée est datée à la réception ; l'avatar est montré ~120 ms dans le passé, entre les deux dernières
 * positions — le léger retard voulu qui rend le mouvement fluide malgré des paquets irréguliers.
 */
export interface PoseSample {
  t: number;
  /** `[x, y, z]` en mètres, lacet et tangage en radians, assis ou non. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  seated: boolean;
}

export const poses = new Map<string, PoseSample[]>();

/** Décode une position du protocole (`[cm, cm, cm, mrad, mrad, bits]`). */
export function decodePose(p: number[], t: number): PoseSample {
  return { t, x: p[0] / 100, y: p[1] / 100, z: p[2] / 100, yaw: p[3] / 1000, pitch: p[4] / 1000, seated: (p[5] & 1) === 1 };
}

export function pushPose(id: string, p: number[], t = performance.now()): void {
  const list = poses.get(id) ?? [];
  list.push(decodePose(p, t));
  if (list.length > 6) list.splice(0, list.length - 6);
  poses.set(id, list);
}

export function forgetPoses(keep?: Set<string>): void {
  for (const id of [...poses.keys()]) if (!keep?.has(id)) poses.delete(id);
}
