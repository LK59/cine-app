import type { Key } from "../lib/i18n";
import type { ImmersionState } from "../state/store";
import { NIGHT_LAMPS } from "./geometry/night";
import { PENDANTS } from "./geometry/south";
import { BED, FIRE, HIFI, LAMPS, ROOM, SOFA, TUB, type RoomId } from "./layout";

/**
 * Ce que le visiteur peut faire dans le chalet, en dehors de regarder un film : s'asseoir ou s'allonger
 * quelque part, et agir sur une chose qu'il regarde de près (une lampe, le feu, la porte-fenêtre, le chat).
 *
 * Tout est décrit ici, en données : où c'est, à quelle distance ça répond, ce que ça propose, ce que
 * ça fait. `Player` cherche à chaque image ce qui est à portée et dans le regard ; les intentions
 * (`actions.ts`) déclenchent ; `Hints` affiche. Un casque ou une manette passeraient par les mêmes
 * intentions (`docs/VR.md`).
 */
export type SeatId = "sofa" | "bed" | "tub";

export interface Seat {
  /** Où se posent les yeux. */
  eye: [number, number, number];
  /** Où le corps attend, et où l'on se retrouve en se relevant. */
  stand: [number, number, number];
  /** Le regard à l'installation ; absent : on garde le sien. */
  yaw?: number;
  pitch?: number;
  hint: Key;
}

export const SEATS: Record<SeatId, Seat> = {
  sofa: { eye: SOFA.seatEye, stand: SOFA.standPoint, hint: "hint.sit" },
  // Allongé, la tête sur l'oreiller, face à la télévision de la chambre.
  bed: { eye: [BED.headX + 0.62, BED.top + 0.4, BED.z + 0.42], stand: [BED.headX + 1.1, 0, BED.z + BED.width / 2 + 0.6], yaw: -Math.PI / 2, pitch: 0.06, hint: "hint.lie" },
  // Dans le bain, de l'eau jusqu'aux épaules, face à la vallée.
  tub: { eye: [TUB.x - 0.3, TUB.water + 0.4, TUB.z + 0.3], stand: [TUB.x - 0.2, 0, TUB.z + TUB.radius + 1.05], yaw: 0.25, pitch: 0.04, hint: "hint.bathe" },
};

/** Le siège qu'on peut prendre d'ici, s'il y en a un. */
export function seatNear(room: RoomId, x: number, y: number, z: number): SeatId | null {
  if (room === "chambre") return Math.hypot(x - (BED.headX + BED.length / 2), z - BED.z) < 2.5 ? "bed" : null;
  if (room === "terrasse") return Math.hypot(x - TUB.x, z - TUB.z) < TUB.radius + 1.7 ? "tub" : null;
  if (room === "salon" && y < 1) return "sofa";
  return null;
}

/** Le chat dort sur un pouf, près du feu. */
export const CAT = { x: 3.2, y: 0.43, z: -0.4 } as const;

export interface Thing {
  id: string;
  at: [number, number, number];
  /** Distance à laquelle la chose répond, depuis les yeux. */
  radius: number;
  /** À quel point il faut la regarder : cosinus minimal entre le regard et sa direction. */
  aim: number;
  hint: (state: ImmersionState) => Key;
  act: (state: ImmersionState) => void;
}

const lamp = (id: string, at: [number, number, number], group: "salon" | "sud" | "nuit", radius: number): Thing => ({
  id,
  at,
  radius,
  aim: 0.78,
  hint: (s) => (s.lamps[group] ? "hint.lamp.off" : "hint.lamp.on"),
  act: (s) => s.toggleLamps(group),
});

export const THINGS: Thing[] = [
  { id: "door", at: [-0.5, 1.15, ROOM.north + 0.13], radius: 2.1, aim: 0.62, hint: (s) => (s.door ? "hint.door.close" : "hint.door.open"), act: (s) => s.toggleDoor() },
  { id: "fire", at: [FIRE.glow[0] + 0.2, 0.62, FIRE.glow[2]], radius: 2.7, aim: 0.82, hint: (s) => (s.fire ? "hint.fire.off" : "hint.fire.on"), act: (s) => s.toggleFire() },
  ...LAMPS.map(([x, z], i) => lamp(`lamp-salon-${i}`, [x, 1.5, z], "salon", 1.9)),
  lamp("lamp-cuisine", [PENDANTS[1][0], PENDANTS[1][1], PENDANTS[1][2]], "sud", 2.6),
  ...NIGHT_LAMPS.bedside.map(([x, y, z], i) => lamp(`lamp-chevet-${i}`, [x, y, z], "nuit", 1.9)),
  // Les deux platines commandent la même musique.
  ...HIFI.decks.map((deck): Thing => ({ id: `hifi-${deck.id}`, at: [deck.at[0], deck.at[1] + 0.08, deck.at[2]], radius: 1.9, aim: 0.75, hint: (s) => (s.music ? "hint.music.off" : "hint.music.on"), act: (s) => s.toggleMusic() })),
  { id: "cat", at: [CAT.x, CAT.y + 0.1, CAT.z], radius: 1.7, aim: 0.72, hint: () => "hint.cat", act: (s) => s.pet() },
];

/** La chose à portée et dans le regard, s'il y en a une — la mieux visée. */
export function thingAimed(eye: { x: number; y: number; z: number }, yaw: number, pitch: number): Thing | null {
  const cosPitch = Math.cos(pitch);
  const look = { x: -Math.sin(yaw) * cosPitch, y: Math.sin(pitch), z: -Math.cos(yaw) * cosPitch };
  let best: Thing | null = null;
  let bestAim = 0;
  for (const thing of THINGS) {
    const dx = thing.at[0] - eye.x;
    const dy = thing.at[1] - eye.y;
    const dz = thing.at[2] - eye.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance > thing.radius || distance < 1e-3) continue;
    const aim = (dx * look.x + dy * look.y + dz * look.z) / distance;
    if (aim >= thing.aim && aim > bestAim) {
      best = thing;
      bestAim = aim;
    }
  }
  return best;
}
