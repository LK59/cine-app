import { useMemo } from "react";
import { MeshStandardMaterial, type Material } from "three";
import type { MaterialId } from "./geometry/types";
import { usePbr } from "./textures";

/**
 * Les matières du chalet, une par identifiant (`MaterialId`) : la table qui relie ce que la géométrie
 * nomme (« timber », « stone », « linen »…) aux jeux de textures et à leurs réglages.
 */
export function useMaterials(): Record<MaterialId, Material> {
  const floor = usePbr("wood_floor", { roughness: 0.6, env: 1.1, tint: "#b5a698", saturation: 0.7 });
  const timber = usePbr("wood_beam", { tint: "#9c8f84", roughness: 1.05, bump: 1.2, env: 0.5, saturation: 0.5 });
  const planks = usePbr("wood_planks_ceiling", { tint: "#b79f8a", env: 0.4, saturation: 0.85 });
  const stone = usePbr("stone_wall", { bump: 1.6, env: 0.35 });
  const slab = usePbr("stone_slab", { tint: "#9c948c", roughness: 0.9, env: 0.5 });
  const plaster = usePbr("plaster", { tint: "#e9dcc6", env: 0.35 });
  const fabric = usePbr("fabric_sofa", { tint: "#e6dccb", bump: 1.4, env: 0.3, saturation: 0.7 });
  const pillowA = usePbr("fabric_pillow", { tint: "#b9a48c", bump: 1.3, env: 0.25 });
  const pillowB = usePbr("fabric_sofa", { tint: "#8d6f55", bump: 1.6, env: 0.25 });
  const rug = usePbr("rug", { tint: "#c9bba6", bump: 1.2, env: 0.2 });
  const leather = usePbr("leather", { tint: "#a8794f", roughness: 0.75, env: 0.7 });
  const wood = usePbr("wood_beam", { tint: "#8f7f73", roughness: 0.8, env: 0.7, saturation: 0.55 });
  const counter = usePbr("counter_stone", { tint: "#8f8d8c", roughness: 0.55, env: 1.0 });
  const linen = usePbr("linen_white", { tint: "#f1ece2", bump: 1.2, env: 0.25 });
  // Les façades de la cuisine et des rangements : un chêne fumé, mat.
  const cabinet = usePbr("wood_beam", { tint: "#6f655c", roughness: 1.1, env: 0.45, saturation: 0.3 });
  // La neige posée sur la terrasse : mate, à peine bleutée.
  const snow = usePbr("snow", { tint: "#e9eef8", roughness: 1.0, bump: 0.8, env: 0.15 });
  const plain = useMemo(
    () => ({
      metal: new MeshStandardMaterial({ color: "#0d0d0e", roughness: 0.48, metalness: 0.85, envMapIntensity: 0.9 }),
      white: new MeshStandardMaterial({ color: "#d8d0c2", roughness: 0.85 }),
    }),
    []
  );
  return useMemo(() => {
    // Le reflet du film ne se lit que sur ce qui est assez lisse : ces matières-là seulement le calculent
    // (`screenLight.ts`, `SL_MIRROR`).
    for (const material of [floor, counter, slab, leather, plain.metal] as MeshStandardMaterial[]) {
      if (material.defines?.SL_MIRROR === undefined) {
        material.defines = { ...(material.defines ?? {}), SL_MIRROR: "" };
        material.needsUpdate = true;
      }
    }
    return { floor, timber, planks, stone, slab, plaster, fabric, pillowA, pillowB, rug, leather, wood, counter, linen, cabinet, snow, ...plain };
  },
  [floor, timber, planks, stone, slab, plaster, fabric, pillowA, pillowB, rug, leather, wood, counter, linen, cabinet, snow, plain]);
}
