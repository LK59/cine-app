import type { Camera, Material, Mesh, Object3D, Scene, Texture, WebGLRenderer } from "three";

/**
 * Prépare toute la scène pendant l'écran de chargement : les programmes de **toutes** les pièces compilés, et toutes
 * leurs textures envoyées à la carte graphique — y compris celles des pièces cachées (`visibleGroups`).
 *
 * Sans elle, la première vue d'une pièce compilait ses programmes et téléversait ses textures sur le moment : des
 * images de 400 à 550 ms sur une petite puce graphique (mesure du 11/11/2026, Core Ultra 7 255H en simple canal,
 * `slowAt` en fin de parcours), là où un ordinateur plus fort ne voyait qu'un léger accroc.
 *
 * Les objets cachés sont montrés le temps de la compilation (three ne compile que ce qui est visible) puis recachés ;
 * l'accueil couvre le canevas pendant ce temps. Une vidéo n'est pas téléversée : elle n'a pas encore d'image.
 */
export async function warmUp(gl: WebGLRenderer, scene: Scene, camera: Camera): Promise<void> {
  const shown: Object3D[] = [];
  scene.traverse((object) => {
    if (!object.visible) {
      object.visible = true;
      shown.push(object);
    }
  });
  try {
    await gl.compileAsync(scene, camera);
    const textures = new Set<Texture>();
    scene.traverse((object) => {
      const material = (object as Mesh).material as Material | Material[] | undefined;
      for (const m of Array.isArray(material) ? material : material ? [material] : []) {
        for (const value of Object.values(m)) if (value && (value as Texture).isTexture) textures.add(value as Texture);
      }
    });
    for (const texture of textures) {
      const image = (texture as Texture & { image?: unknown }).image;
      if (typeof HTMLVideoElement !== "undefined" && image instanceof HTMLVideoElement) continue;
      gl.initTexture(texture);
    }
  } finally {
    for (const object of shown) object.visible = false;
  }
}
