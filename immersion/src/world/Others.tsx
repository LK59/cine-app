import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { CanvasTexture, Color, Group, LinearFilter, SRGBColorSpace } from "three";
import { poses, type PoseSample } from "../net/poses";
import { sendPos } from "../net/salons";
import { useStore } from "../state/store";
import { rig } from "./rig";

/**
 * Les autres participants du salon (DECISIONS.md §146, étape 2 de `docs/MULTIJOUEUR.md`) : une silhouette simple
 * par personne — un corps, une tête tournée comme son regard, son nom au-dessus —, et l'envoi de notre propre
 * position.
 *
 * Les positions arrivent une dizaine de fois par seconde (`net/poses.ts`) ; chaque avatar est montré ~120 ms dans
 * le passé, entre les deux positions qui encadrent cet instant : un mouvement fluide malgré des paquets irréguliers.
 * C'est la position des **yeux** qui voyage (pas des pieds) : assis, la tête est plus bas, et le corps suit.
 *
 * La couleur vient de l'identifiant (les avatars personnalisables sont l'étape 5).
 */
const DELAY_MS = 120;
const SEND_EVERY_MS = 80;
const HEARTBEAT_MS = 2000;

function colorOf(id: string): Color {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return new Color().setHSL((h % 360) / 360, 0.55, 0.55);
}

function nameTexture(name: string): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 96;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "600 44px Inter, sans-serif";
  const width = Math.min(500, ctx.measureText(name).width + 48);
  ctx.fillStyle = "rgba(10,10,12,0.62)";
  ctx.beginPath();
  ctx.roundRect((512 - width) / 2, 14, width, 68, 34);
  ctx.fill();
  ctx.fillStyle = "#f4efe6";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(name, 256, 50, 470);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  return texture;
}

/** La pose à montrer pour une personne, à l'instant `t` (interpolée, ou la dernière connue). */
function poseAt(samples: PoseSample[], t: number): PoseSample | null {
  if (!samples.length) return null;
  const target = t - DELAY_MS;
  for (let i = samples.length - 1; i > 0; i--) {
    const a = samples[i - 1];
    const b = samples[i];
    if (a.t <= target && target <= b.t) {
      const k = (target - a.t) / Math.max(1, b.t - a.t);
      let dyaw = b.yaw - a.yaw;
      if (dyaw > Math.PI) dyaw -= 2 * Math.PI;
      if (dyaw < -Math.PI) dyaw += 2 * Math.PI;
      return { t: target, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, yaw: a.yaw + dyaw * k, pitch: a.pitch + (b.pitch - a.pitch) * k, seated: b.seated };
    }
  }
  return samples[samples.length - 1];
}

function Avatar({ id, name }: { id: string; name: string }) {
  const group = useRef<Group>(null);
  const head = useRef<Group>(null);
  const color = useMemo(() => colorOf(id), [id]);
  const label = useMemo(() => nameTexture(name), [name]);
  useEffect(() => () => label.dispose(), [label]);

  useFrame(() => {
    const g = group.current;
    const pose = poseAt(poses.get(id) ?? [], performance.now());
    if (!g) return;
    g.visible = !!pose;
    if (!pose) return;
    g.position.set(pose.x, pose.y, pose.z);
    g.rotation.y = pose.yaw;
    if (head.current) head.current.rotation.x = pose.pitch * 0.8;
  });

  return (
    <group ref={group} visible={false}>
      {/* Le corps, sous les yeux (assis, il passe dans le siège : la silhouette reste simple jusqu'à l'étape 5). */}
      <mesh position={[0, -0.82, 0]}>
        <capsuleGeometry args={[0.2, 0.9, 4, 12]} />
        <meshStandardMaterial color={color} roughness={0.7} />
      </mesh>
      <group ref={head}>
        <mesh>
          <sphereGeometry args={[0.15, 20, 14]} />
          <meshStandardMaterial color="#e9d9c6" roughness={0.6} />
        </mesh>
        {/* Une visière : de quel côté il regarde. */}
        <mesh position={[0, 0.01, -0.13]}>
          <boxGeometry args={[0.2, 0.06, 0.04]} />
          <meshStandardMaterial color="#1a1a1e" roughness={0.3} />
        </mesh>
      </group>
      <sprite position={[0, 0.38, 0]} scale={[0.9, 0.17, 1]}>
        <spriteMaterial map={label} depthWrite={false} transparent />
      </sprite>
    </group>
  );
}

/** Envoie notre position quand on bouge (12 fois par seconde au plus), et de temps en temps sinon. */
function PresenceSender() {
  const last = useRef({ at: 0, p: [] as number[] });
  useFrame(() => {
    const state = useStore.getState();
    if (!state.net.room) return;
    const now = performance.now();
    if (now - last.current.at < SEND_EVERY_MS) return;
    const p = [Math.round(rig.eye.x * 100), Math.round(rig.eye.y * 100), Math.round(rig.eye.z * 100), Math.round(rig.yaw * 1000), Math.round(rig.pitch * 1000), state.seated ? 1 : 0];
    const before = last.current.p;
    const moved = before.length !== 6 || Math.abs(p[0] - before[0]) + Math.abs(p[1] - before[1]) + Math.abs(p[2] - before[2]) > 2 || Math.abs(p[3] - before[3]) > 15 || Math.abs(p[4] - before[4]) > 15 || p[5] !== before[5];
    if (!moved && now - last.current.at < HEARTBEAT_MS) return;
    last.current = { at: now, p };
    sendPos(p);
  });
  return null;
}

export function Others() {
  const you = useStore((s) => s.net.you?.id ?? null);
  const members = useStore((s) => s.net.room?.members ?? null);
  const others = (members ?? []).filter((m) => m.id !== you);
  return (
    <>
      <PresenceSender />
      {others.map((m) => (
        <Avatar key={m.id} id={m.id} name={m.name} />
      ))}
    </>
  );
}
