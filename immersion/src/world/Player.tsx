import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { CapsuleCollider, RigidBody, useRapier, type RapierCollider, type RapierRigidBody } from "@react-three/rapier";
import { Euler, MathUtils, PerspectiveCamera, Vector3 } from "three";
import { useStore } from "../state/store";
import { motion } from "../input/intents";
import { nearestScreen, PLAYER, ROOM, roomAt, SOFA } from "./layout";
import { rig } from "./rig";
import { benchPose, benchRun } from "../bench/bench";

const euler = new Euler(0, 0, 0, "YXZ");
const eye = new Vector3();
const seat = new Vector3(...SOFA.seatEye);

/**
 * Le visiteur : une capsule déplacée par le contrôleur de personnage de Rapier, et la caméra posée
 * à hauteur d'yeux.
 *
 * Le contrôleur fait ce qu'un test de collision à la main fait mal : glisser le long d'un mur pris
 * de biais, monter une marche sans sauter, rester collé au sol dans un escalier. La capsule est
 * cinématique — rien ne la pousse, elle va où on la pose — et la gravité est tenue ici.
 */
export function Player() {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const { world } = useRapier();
  const body = useRef<RapierRigidBody>(null);
  const collider = useRef<RapierCollider>(null);
  const velocity = useRef(new Vector3());
  const fall = useRef(0);
  const eyeHeight = useRef<number>(PLAYER.eye);
  const seatBlend = useRef(0);

  const controller = useMemo(() => {
    const c = world.createCharacterController(0.02);
    c.enableAutostep(0.32, 0.18, true);
    c.enableSnapToGround(0.32);
    c.setMaxSlopeClimbAngle(MathUtils.degToRad(50));
    c.setMinSlopeSlideAngle(MathUtils.degToRad(60));
    c.setApplyImpulsesToDynamicBodies(false);
    return c;
  }, [world]);
  useEffect(() => () => world.removeCharacterController(controller), [world, controller]);

  useFrame((_, delta) => {
    const rb = body.current;
    const col = collider.current;
    if (!rb || !col) return;
    // Un onglet revenu de l'arrière-plan rend une image de plusieurs secondes : on ne traverse pas un mur pour autant.
    const dt = Math.min(delta, 0.05);
    const state = useStore.getState();
    const walking = state.phase === "world" && state.mode === "walk";

    if (rig.teleport) {
      rb.setTranslation({ x: rig.teleport.x, y: rig.teleport.y + PLAYER.height / 2, z: rig.teleport.z }, true);
      rig.position.copy(rig.teleport);
      rig.teleport = null;
      velocity.current.set(0, 0, 0);
      fall.current = 0;
    }

    // Une mesure est en cours : la caméra suit son parcours fixe. Le personnage, lui, ne bouge pas — il
    // retrouve sa place à la fin ; seule la pièce « où l'on est » suit la caméra, pour que ce qui se
    // dessine soit ce qu'un visiteur verrait de là.
    if (benchRun.active) {
      const at = benchPose(camera, performance.now());
      rig.eye.copy(at);
      state.setRoom(roomAt(at.x, 0, at.z));
      return;
    }

    // Le mouvement voulu, tel que le périphérique d'entrée le tient (`input/intents.ts`).
    const forward = walking ? motion.forward : 0;
    const strafe = walking ? motion.strafe : 0;
    const moving = forward !== 0 || strafe !== 0;
    // Se déplacer, c'est se lever.
    if (moving && state.seated) state.setSeated(false);

    const speed = motion.run ? PLAYER.run : PLAYER.walk;
    const sin = Math.sin(rig.yaw);
    const cos = Math.cos(rig.yaw);
    let tx = 0;
    let tz = 0;
    if (moving && !state.seated) {
      // Une manette donnerait une fraction ; au clavier c'est tout ou rien, et la diagonale ne va pas plus vite.
      const length = Math.max(1, Math.hypot(forward, strafe));
      tx = ((-sin * forward + cos * strafe) / length) * speed;
      tz = ((-cos * forward - sin * strafe) / length) * speed;
    }
    // Une mise en mouvement et un arrêt brefs mais pas instantanés : le pas, pas le patin.
    const ease = 1 - Math.exp(-dt * 11);
    velocity.current.x += (tx - velocity.current.x) * ease;
    velocity.current.z += (tz - velocity.current.z) * ease;
    fall.current -= 9.81 * dt;

    controller.computeColliderMovement(col, { x: velocity.current.x * dt, y: fall.current * dt, z: velocity.current.z * dt });
    const move = controller.computedMovement();
    if (controller.computedGrounded()) fall.current = 0;
    const at = rb.translation();
    const next = { x: at.x + move.x, y: at.y + move.y, z: at.z + move.z };
    // Filet : une chute hors du monde (un trou dans les collisions) ramène à l'entrée.
    if (next.y < -20) {
      rig.teleport = new Vector3(...PLAYER.spawn);
      return;
    }
    rb.setNextKinematicTranslation(next);
    rig.position.set(next.x, next.y - PLAYER.height / 2, next.z);

    // Les yeux : au-dessus des pieds, lissés en hauteur (une marche ne doit pas secouer l'image).
    const targetEye = rig.position.y + PLAYER.eye;
    eyeHeight.current += (targetEye - eyeHeight.current) * (1 - Math.exp(-dt * 14));
    eye.set(rig.position.x, eyeHeight.current, rig.position.z);

    // Assis : la caméra glisse vers le canapé, et en revient en se levant.
    const target = state.seated ? 1 : 0;
    seatBlend.current += (target - seatBlend.current) * (1 - Math.exp(-dt * 4.5));
    if (Math.abs(target - seatBlend.current) < 0.001) seatBlend.current = target;
    if (seatBlend.current > 0) eye.lerp(seat, MathUtils.smootherstep(seatBlend.current, 0, 1));

    // Le panneau est ouvert : le regard glisse vers lui, par le plus court chemin.
    if (rig.aim && state.mode === "panel") {
      const k = 1 - Math.exp(-dt * 9);
      const turn = Math.atan2(Math.sin(rig.aim.yaw - rig.yaw), Math.cos(rig.aim.yaw - rig.yaw));
      rig.yaw += turn * k;
      rig.pitch += (rig.aim.pitch - rig.pitch) * k;
    }

    camera.position.copy(eye);
    rig.eye.copy(eye);
    euler.set(rig.pitch, rig.yaw, 0);
    camera.quaternion.setFromEuler(euler);
    if (camera.fov !== state.settings.fov) {
      camera.fov = state.settings.fov;
      camera.updateProjectionMatrix();
    }

    // Ce que le visiteur peut faire d'ici : ouvrir l'écran le plus proche, s'asseoir.
    const inRoom = rig.position.z < ROOM.south + 0.5 && Math.abs(rig.position.x) < ROOM.halfW && rig.position.y < 1;
    const near = nearestScreen(eye.x, eye.y, eye.z);
    state.setNear({ screen: near.distance < near.screen.reach ? near.screen.id : null, sofa: inRoom });
    state.setRoom(roomAt(rig.position.x, rig.position.y, rig.position.z));
  });

  return (
    <RigidBody ref={body} type="kinematicPosition" colliders={false} position={[PLAYER.spawn[0], PLAYER.height / 2, PLAYER.spawn[2]]} enabledRotations={[false, false, false]}>
      <CapsuleCollider ref={collider} args={[PLAYER.height / 2 - PLAYER.radius, PLAYER.radius]} />
    </RigidBody>
  );
}
