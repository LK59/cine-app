import { Vector3 } from "three";
import { PLAYER } from "./layout";

/**
 * Un personnage dans le chalet : un identifiant, une position (ses pieds), une orientation.
 *
 * Il n'y en a qu'un aujourd'hui — le visiteur de cette page —, mais rien ici ne le suppose : c'est une
 * entrée d'un registre, et la caméra n'est pas son état (elle le *lit*, voir `Player.tsx`). D'autres
 * visiteurs seraient d'autres entrées, tenues à jour par le réseau (`docs/MULTIJOUEUR.md`).
 */
export interface Character {
  id: string;
  /** Les pieds. */
  position: Vector3;
  yaw: number;
  pitch: number;
}

export const characters = new Map<string, Character>();

export function addCharacter(id: string): Character {
  const character: Character = { id, position: new Vector3(...PLAYER.spawn), yaw: PLAYER.spawnYaw, pitch: PLAYER.spawnPitch };
  characters.set(id, character);
  return character;
}

/** L'identifiant du personnage de cette page. */
export const LOCAL = "local";

/**
 * Le personnage de cette page, et ce qui ne regarde que sa manette locale : ces valeurs changent à
 * chaque image, elles sont hors de l'état React exprès.
 */
export const rig = Object.assign(addCharacter(LOCAL), {
  /** Une téléportation demandée (tests, « se lever ») : appliquée à la prochaine image. */
  teleport: null as Vector3 | null,
  /** Où le regard doit se poser (le panneau ouvert) : la caméra y glisse, le périphérique ne la tourne plus. */
  aim: null as { yaw: number; pitch: number } | null,
  /** Les yeux, tels que la caméra les a posés à la dernière image. */
  eye: new Vector3(PLAYER.spawn[0], PLAYER.eye, PLAYER.spawn[2]),
});

export function resetRig(): void {
  rig.position.set(...PLAYER.spawn);
  rig.yaw = PLAYER.spawnYaw;
  rig.pitch = PLAYER.spawnPitch;
  rig.teleport = rig.position.clone();
}

/** Tourne la tête de `dx`/`dy` unités de regard (des pixels de souris, aujourd'hui). */
export function look(dx: number, dy: number, sensitivity: number): void {
  const k = 0.0022 * sensitivity;
  rig.yaw -= dx * k;
  rig.pitch = Math.max(-1.45, Math.min(1.45, rig.pitch - dy * k));
}
