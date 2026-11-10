// Ramène la hauteur des images du panorama à un multiple de 4 (usage : node fit4.mjs <dossier> <sortie>).
//
// Les textures compressées par blocs (BC7, ASTC…) que le navigateur reçoit après transcodage exigent
// des dimensions multiples de 4 : à 1366 ou 683 pixels de haut, WebGL refuse l'image et la couche
// s'affiche noire, sans erreur visible. L'étirement est de 0,15 % : invisible.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// Dans l'image d'outils, sharp est installé à part (NODE_PATH) : `import` ne le trouverait pas.
const sharp = createRequire(import.meta.url)("sharp");

const [input, output] = process.argv.slice(2);
fs.mkdirSync(output, { recursive: true });
for (const name of ["far", "mid", "near"]) {
  const image = sharp(path.join(input, `${name}.png`), { limitInputPixels: false });
  const { width, height } = await image.metadata();
  const fitted = Math.ceil(height / 4) * 4;
  if (width % 4) throw new Error(`${name} : largeur ${width} non multiple de 4`);
  await image.resize(width, fitted, { fit: "fill", kernel: "lanczos3" }).png({ compressionLevel: 3 }).toFile(path.join(output, `${name}.png`));
  console.log(`${name} : ${width}×${height} → ${width}×${fitted}`);
}
