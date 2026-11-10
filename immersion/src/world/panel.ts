import { Vector3 } from "three";
import { SCREENS, type Screen } from "./layout";
import { rig } from "./rig";

/**
 * Où le panneau Laterna apparaît : devant le visiteur, entre lui et l'écran qu'il vient d'ouvrir,
 * tourné vers lui.
 *
 * Posé à l'ouverture puis immobile dans le monde : c'est un objet de la pièce, pas un calque collé à
 * l'écran. Sa distance (1,5 m) et sa largeur (2,5 m) sont réglées pour qu'un pixel de son contenu
 * fasse à peu près un pixel d'écran — en dessous, le texte fond.
 */
export const PANEL = { width: 2.5, pixels: 1180, height: 700, distance: 1.5 } as const;

export const panelPose = { position: new Vector3(), yaw: 0 };

/** Pose le panneau pour cet écran, et dit au regard où se tourner. */
export function placePanel(screen: Screen): void {
  const eye = rig.eye;
  const [sx, , sz] = screen.center;
  const toScreen = new Vector3(sx - eye.x, 0, sz - eye.z);
  const gap = toScreen.length();
  const direction = gap > 0.1 ? toScreen.normalize() : new Vector3(Math.sin(screen.yaw), 0, Math.cos(screen.yaw)).negate();
  // Jamais dans le mur : tout contre l'écran, le panneau se rapproche du visiteur.
  const reach = Math.max(0.9, Math.min(PANEL.distance, gap - 0.75));
  panelPose.position.copy(eye).addScaledVector(direction, reach);
  panelPose.position.y = eye.y - 0.03;
  panelPose.yaw = Math.atan2(eye.x - panelPose.position.x, eye.z - panelPose.position.z);
  rig.aim = { yaw: Math.atan2(-(panelPose.position.x - eye.x), -(panelPose.position.z - eye.z)), pitch: -0.02 };
}

/**
 * L'écran que le regard vise, s'il en vise un à portée : le rayon des yeux est croisé avec le plan de
 * chaque dalle. C'est ce que « valider » (le clic) ouvre.
 */
export function aimedScreen(): Screen | null {
  const dx = -Math.sin(rig.yaw) * Math.cos(rig.pitch);
  const dy = Math.sin(rig.pitch);
  const dz = -Math.cos(rig.yaw) * Math.cos(rig.pitch);
  for (const screen of SCREENS) {
    const [cx, cy, cz] = screen.center;
    // La normale de la dalle, dans le plan horizontal.
    const nx = Math.sin(screen.yaw);
    const nz = Math.cos(screen.yaw);
    const facing = dx * nx + dz * nz;
    if (facing > -0.05) continue;
    const t = ((cx - rig.eye.x) * nx + (cz - rig.eye.z) * nz) / facing;
    if (t < 0.3 || t > 9) continue;
    const hx = rig.eye.x + dx * t - cx;
    const hy = rig.eye.y + dy * t - cy;
    const hz = rig.eye.z + dz * t - cz;
    const along = hx * nz - hz * nx;
    if (Math.abs(along) < screen.width / 2 && Math.abs(hy) < (screen.width * 9) / 32) return screen;
  }
  return null;
}
