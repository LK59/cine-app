import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Color, CylinderGeometry, MeshStandardMaterial, type Group } from "three";
import { loudspeaker, musicPlaying, setMusic } from "../media/music";
import { useStore } from "../state/store";
import { HIFI, LOUDSPEAKERS } from "./layout";

/**
 * La chaîne hi-fi : les platines (salon, chambre), les enceintes de chaque pièce, et leurs haut-parleurs.
 *
 * Les deux platines commandent la même musique. Quand elle joue, les disques tournent et les bras sont
 * posés ; à l'arrêt — ou pendant un film, qui la fait taire —, les bras se relèvent. Une petite diode
 * dit si la chaîne est en marche.
 */
export function HiFi() {
  const on = useStore((s) => s.music);
  const film = useStore((s) => s.playback.status !== "idle" && s.playback.status !== "error");
  const discs = useRef<(Group | null)[]>([]);
  const arms = useRef<(Group | null)[]>([]);
  const spin = useRef(0);
  const arm = useRef(0);

  const parts = useMemo(
    () => ({
      plinth: new MeshStandardMaterial({ color: "#3a2a1e", roughness: 0.55 }),
      black: new MeshStandardMaterial({ color: "#0b0b0c", roughness: 0.4, metalness: 0.3 }),
      vinyl: new MeshStandardMaterial({ color: "#060606", roughness: 0.28, metalness: 0.1, envMapIntensity: 1.6 }),
      label: new MeshStandardMaterial({ color: "#b8632e", roughness: 0.7 }),
      steel: new MeshStandardMaterial({ color: "#b9bcc2", roughness: 0.3, metalness: 0.9 }),
      cloth: new MeshStandardMaterial({ color: "#191817", roughness: 0.95 }),
      cone: new MeshStandardMaterial({ color: "#2a2a2c", roughness: 0.6, metalness: 0.2 }),
      diode: new MeshStandardMaterial({ color: "#1a0d05", emissive: new Color("#ff9a3c"), emissiveIntensity: 0 }),
      disc: new CylinderGeometry(0.15, 0.15, 0.004, 48),
      platter: new CylinderGeometry(0.155, 0.155, 0.018, 48),
      round: new CylinderGeometry(1, 1, 1, 24),
      speakers: LOUDSPEAKERS.map((s) => loudspeaker(s.id, s.loudness)),
    }),
    []
  );
  useEffect(
    () => () => {
      for (const m of [parts.plinth, parts.black, parts.vinyl, parts.label, parts.steel, parts.cloth, parts.cone, parts.diode]) m.dispose();
      for (const g of [parts.disc, parts.platter, parts.round]) g.dispose();
    },
    [parts]
  );

  // La chaîne suit son interrupteur, et se tait pendant un film.
  useEffect(() => {
    setMusic(on, film);
  }, [on, film]);

  useFrame((_, delta) => {
    const playing = musicPlaying();
    const dt = Math.min(delta, 0.1);
    // 33 tours et un tiers par minute.
    if (playing) spin.current += dt * ((33.33 / 60) * Math.PI * 2);
    for (const disc of discs.current) if (disc) disc.rotation.y = -spin.current;
    arm.current += ((playing ? 1 : 0) - arm.current) * (1 - Math.exp(-dt * 2.2));
    for (const a of arms.current) if (a) a.rotation.y = -0.1 - arm.current * 0.38;
    parts.diode.emissiveIntensity = on ? 2.6 : 0;
  });

  /** Une enceinte : un coffret, son tissu, deux membranes. */
  const box = (w: number, h: number, d: number) => (
    <>
      <mesh material={parts.plinth}>
        <boxGeometry args={[w, h, d]} />
      </mesh>
      <mesh material={parts.cloth} position={[0, 0, d / 2 + 0.002]}>
        <boxGeometry args={[w - 0.03, h - 0.03, 0.004]} />
      </mesh>
      <mesh geometry={parts.round} material={parts.cone} position={[0, -h * 0.14, d / 2 + 0.006]} rotation-x={Math.PI / 2} scale={[w * 0.3, 0.006, w * 0.3]} />
      <mesh geometry={parts.round} material={parts.cone} position={[0, h * 0.27, d / 2 + 0.006]} rotation-x={Math.PI / 2} scale={[w * 0.13, 0.006, w * 0.13]} />
    </>
  );

  return (
    <group name="hifi">
      {HIFI.decks.map((deck, i) => (
        <group key={deck.id} position={deck.at} rotation-y={deck.yaw} name={`deck-${deck.id}`}>
          {/* Le socle, le plateau, le disque et son étiquette. */}
          <mesh material={parts.plinth} position={[0, 0.03, 0]}>
            <boxGeometry args={[0.44, 0.06, 0.36]} />
          </mesh>
          <mesh geometry={parts.platter} material={parts.black} position={[-0.04, 0.069, 0]} />
          <group ref={(node) => void (discs.current[i] = node)} position={[-0.04, 0.081, 0]}>
            <mesh geometry={parts.disc} material={parts.vinyl} />
            <mesh geometry={parts.round} material={parts.label} position={[0, 0.0026, 0]} scale={[0.05, 0.001, 0.05]} />
            {/* Un repère sur l'étiquette : sans lui, on ne verrait pas le disque tourner. */}
            <mesh material={parts.steel} position={[0.03, 0.0034, 0]}>
              <boxGeometry args={[0.018, 0.0008, 0.006]} />
            </mesh>
          </group>
          <mesh geometry={parts.round} material={parts.steel} position={[-0.04, 0.09, 0]} scale={[0.004, 0.02, 0.004]} />
          {/* Le bras : son pivot au fond à droite, la tête de lecture au bout. */}
          <group ref={(node) => void (arms.current[i] = node)} position={[0.17, 0.085, -0.12]} rotation-y={-0.1}>
            <mesh geometry={parts.round} material={parts.steel} scale={[0.016, 0.03, 0.016]} />
            <mesh material={parts.steel} position={[0, 0.012, 0.12]}>
              <boxGeometry args={[0.008, 0.008, 0.25]} />
            </mesh>
            <mesh material={parts.black} position={[0, 0.006, 0.245]}>
              <boxGeometry args={[0.02, 0.012, 0.035]} />
            </mesh>
          </group>
          <mesh material={parts.diode} position={[0.19, 0.062, 0.155]}>
            <boxGeometry args={[0.012, 0.006, 0.012]} />
          </mesh>
        </group>
      ))}
      {/* Les deux enceintes de la console du salon, de part et d'autre de la platine. */}
      {[-0.62, 0.62].map((dz) => (
        <group key={dz} position={[HIFI.decks[0].at[0], HIFI.console.top + 0.17, HIFI.decks[0].at[2] + dz]} rotation-y={Math.PI / 2}>
          {box(0.2, 0.34, 0.22)}
        </group>
      ))}
      {/* Une enceinte par autre pièce — et, sur chacune, son haut-parleur. */}
      {LOUDSPEAKERS.map((speaker, i) => (
        <group key={speaker.id} position={speaker.center} rotation-y={speaker.yaw}>
          {speaker.id === "salon" ? null : box(0.19, 0.3, 0.2)}
          <primitive object={parts.speakers[i]} position={[0, 0, 0.12]} />
        </group>
      ))}
    </group>
  );
}
