import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { CubeCamera, FogExp2, HalfFloatType, LinearMipmapLinearFilter, PMREMGenerator, WebGLCubeRenderTarget, type Texture } from "three";
import { useStore } from "../state/store";
import { CHANDELIER } from "./layout";

/**
 * Ce qui fait tenir la lumière ensemble, calculé une fois :
 *
 * - **L'environnement de la pièce.** Le salon est photographié de l'intérieur, dans les six
 *   directions, et cette image sert d'éclairage ambiant et de reflets à toutes les matières : le
 *   parquet reflète la baie bleue, la dalle éteinte de la télévision reflète la pièce, et les ombres
 *   prennent la couleur de ce qui les entoure au lieu d'un gris uniforme. Deux prises : la seconde
 *   voit la pièce déjà éclairée par la première, ce qui donne un rebond de plus.
 * - **Les ombres figées.** Rien ne bouge dans le chalet : les cartes d'ombre sont dessinées pendant
 *   les premières images, puis plus jamais — sauf quand le préréglage de qualité change.
 * - **La brume** du dehors, trop légère pour se voir à l'échelle d'une pièce, qui fond les montagnes
 *   dans le ciel.
 */
export function Atmosphere() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const quality = useStore((s) => s.settings.quality);
  const frame = useRef(0);
  const kept = useRef<Texture | null>(null);

  useEffect(() => {
    scene.fog = new FogExp2("#0c1a36", 0.0048);
    return () => {
      scene.fog = null;
      scene.environment = null;
      kept.current?.dispose();
      kept.current = null;
      gl.shadowMap.autoUpdate = true;
    };
  }, [scene, gl]);

  // Un préréglage qui change refait les ombres (leur taille a changé) et l'environnement.
  useEffect(() => {
    frame.current = 0;
  }, [quality]);

  useFrame(() => {
    if (frame.current < 0) return;
    frame.current += 1;
    gl.shadowMap.autoUpdate = false;
    if (frame.current <= 5) gl.shadowMap.needsUpdate = true;
    if (frame.current === 3 || frame.current === 5) {
      const target = new WebGLCubeRenderTarget(256, { type: HalfFloatType, generateMipmaps: true, minFilter: LinearMipmapLinearFilter });
      const camera = new CubeCamera(0.1, 500, target);
      camera.position.set(CHANDELIER.x, 2.3, CHANDELIER.z);
      camera.update(gl, scene);
      const pmrem = new PMREMGenerator(gl);
      const environment = pmrem.fromCubemap(target.texture).texture;
      pmrem.dispose();
      target.dispose();
      kept.current?.dispose();
      kept.current = environment;
      scene.environment = environment;
      scene.environmentIntensity = 0.5;
    }
    if (frame.current >= 6) frame.current = -1;
  }, -2);

  return null;
}
