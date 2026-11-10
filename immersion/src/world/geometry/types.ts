import type { BufferGeometry } from "three";
import type { Solid } from "../layout";

/**
 * Les matières dont le chalet est bâti. Chaque partie du chalet (`Part`) rend un maillage par
 * matière ; la table qui les relie aux textures est dans `materials.ts`.
 */
export type MaterialId =
  | "floor"
  | "timber"
  | "planks"
  | "stone"
  | "slab"
  | "plaster"
  | "fabric"
  | "pillowA"
  | "pillowB"
  | "rug"
  | "leather"
  | "wood"
  | "metal"
  | "counter"
  | "linen"
  | "cabinet"
  | "white";

/**
 * Une partie du chalet : ce qui se dessine (un maillage par matière) et ce qui arrête le visiteur.
 * Construite par des fonctions pures — sans React, sans navigateur — pour que la même géométrie serve
 * au rendu et à la cuisson de la lumière (`tools/bake/`).
 */
export interface Part {
  meshes: Partial<Record<MaterialId, BufferGeometry>>;
  solids: Solid[];
}

/** Les groupes de pièces : ce qui se dessine ensemble, et dont la lumière est cuite ensemble. */
export type GroupId = "salon" | "sud" | "nuit";
