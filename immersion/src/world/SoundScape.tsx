import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { ambience, applyAcoustics, audio, DUCKED, setOutdoors } from "../media/audio";
import { syncMix } from "../media/playback";
import { useStore } from "../state/store";
import { applyMusicAcoustics } from "../media/music";
import { CHANDELIER, fadeByRange, LOUDSPEAKERS, rangeGain, ROOM, roomAt, SCREENS, type RoomId } from "./layout";
import { rig } from "./rig";

/**
 * Ce qui passe du son d'une pièce à l'autre : la fréquence au-delà de laquelle un écran de la pièce
 * `from` ne s'entend plus depuis la pièce `to`.
 *
 * Le salon, la cuisine et la mezzanine forment un seul volume ouvert : le son y circule presque
 * intact. Le couloir est derrière un mur percé d'une porte ; la chambre, derrière deux.
 */
const OPEN: RoomId[] = ["salon", "cuisine", "mezzanine"];
export function cutoffBetween(from: RoomId, to: RoomId, doorOpen = false): number {
  if (from === to) return 20000;
  // Dehors, on entend le salon à travers la baie : étouffé porte close, presque net porte ouverte.
  if (to === "terrasse") return OPEN.includes(from) ? (doorOpen ? 6500 : 1100) : 300;
  const fromOpen = OPEN.includes(from);
  const toOpen = OPEN.includes(to);
  if (fromOpen && toOpen) return from === "cuisine" || to === "cuisine" ? 6500 : 9000;
  if (from === "chambre" || to === "chambre") return fromOpen || toOpen ? 650 : 1600;
  return 1500;
}

/**
 * Ce qui reste du dehors (vent, bain) selon la pièce et la baie. Porte close, un double vitrage et des murs
 * de rondins : une vingtaine de décibels de moins (0,08 ≈ −22 dB) et rien au-dessus de quelques centaines de
 * hertz. Porte ouverte, le dehors entre presque entier dans le volume ouvert, moins dans les pièces du fond.
 */
export function outdoorsHeard(here: RoomId, doorOpen: boolean): { level: number; cutoff: number } {
  if (here === "terrasse") return { level: 1, cutoff: 20000 };
  if (OPEN.includes(here)) return doorOpen ? { level: 0.6, cutoff: 6000 } : { level: 0.08, cutoff: 380 };
  return doorOpen ? { level: 0.18, cutoff: 1200 } : { level: 0.03, cutoff: 260 };
}

/**
 * L'oreille et les sons d'ambiance : l'écoute est accrochée à la caméra, le vent à la baie, le
 * grésillement des bougies au lustre. Les haut-parleurs des écrans sont posés par `Screens`.
 */
export function SoundScape() {
  const camera = useThree((s) => s.camera);
  const graph = useMemo(() => audio(), []);
  const volume = useStore((s) => s.settings.volume);
  const spatial = useStore((s) => s.settings.spatial);
  const reverb = useStore((s) => s.settings.reverb);
  const muted = useStore((s) => s.playback.muted);

  useEffect(() => {
    camera.add(graph.listener);
    return () => {
      camera.remove(graph.listener);
    };
  }, [camera, graph]);

  useEffect(() => {
    syncMix();
  }, [volume, spatial, reverb, muted]);

  useFrame(() => {
    const here = roomAt(rig.position.x, rig.position.y, rig.position.z);
    const doorOpen = useStore.getState().door;
    // Pendant un film, les bruits de fond se mettent en retrait (ils reviennent à la pause).
    const playback = useStore.getState().playback;
    const film = playback.status === "playing" && !playback.wantPaused;
    ambience.value += ((film ? DUCKED : 1) - ambience.value) * 0.03;
    // Le vent et le bain : pleins dehors, à peine un souffle sourd derrière la baie close.
    setOutdoors(outdoorsHeard(here, doorOpen));
    // Les enceintes de la chaîne hi-fi : même acoustique que les écrans.
    for (const speaker of LOUDSPEAKERS) {
      const distance = Math.hypot(speaker.center[0] - rig.eye.x, speaker.center[1] - rig.eye.y, speaker.center[2] - rig.eye.z);
      applyMusicAcoustics(speaker.id, cutoffBetween(speaker.room, here, doorOpen), fadeByRange(speaker.range, distance));
    }
    for (const screen of SCREENS) {
      // La distance de l'oreille à la dalle décide de ce qu'il reste de son haut-parleur (sa portée).
      const distance = Math.hypot(screen.center[0] - rig.eye.x, screen.center[1] - rig.eye.y, screen.center[2] - rig.eye.z);
      applyAcoustics(screen.id, cutoffBetween(screen.room, here, doorOpen), rangeGain(screen, distance));
    }
  });

  return (
    <>
      <primitive object={graph.wind} position={[0, 2.6, ROOM.north - 0.6]} />
      <primitive object={graph.candles} position={[CHANDELIER.x, CHANDELIER.y, CHANDELIER.z]} />
    </>
  );
}
