import { Vector3 } from "three";
import { PLAYER } from "./layout";

/**
 * Le visiteur, tel que la boucle d'image le tient : où il est, où il regarde. Hors de l'état React
 * exprès — ces valeurs changent à chaque image.
 */
export const rig = {
  /** Les pieds. */
  position: new Vector3(...PLAYER.spawn),
  yaw: PLAYER.spawnYaw as number,
  pitch: PLAYER.spawnPitch as number,
  /** Une téléportation demandée (tests, « se lever ») : appliquée à la prochaine image. */
  teleport: null as Vector3 | null,
  /** Où le regard doit se poser (le panneau ouvert) : la caméra y glisse, la souris ne la tourne plus. */
  aim: null as { yaw: number; pitch: number } | null,
  /** Les yeux, tels que la caméra les a posés à la dernière image. */
  eye: new Vector3(PLAYER.spawn[0], PLAYER.eye, PLAYER.spawn[2]),
};

export function resetRig(): void {
  rig.position.set(...PLAYER.spawn);
  rig.yaw = PLAYER.spawnYaw;
  rig.pitch = PLAYER.spawnPitch;
  rig.teleport = rig.position.clone();
}

/** Tourne la tête de `dx`/`dy` pixels de souris. */
export function look(dx: number, dy: number, sensitivity: number): void {
  const k = 0.0022 * sensitivity;
  rig.yaw -= dx * k;
  rig.pitch = Math.max(-1.45, Math.min(1.45, rig.pitch - dy * k));
}
