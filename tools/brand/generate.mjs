// Produit toutes les icônes et tous les écrans de lancement de `public/` depuis les SVG de ce
// dossier. Rien n'est dessiné à la main : relancer ce script sur les mêmes sources redonne les
// mêmes fichiers (même rendu librsvg, mêmes options PNG). Voir README.md pour la commande.
//
// Lancé depuis la racine du dépôt. `sharp` est celui de l'application (dépendance de Next).
import sharp from "sharp";
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC = "tools/brand";
const PUBLIC = "public";
const svg = (name) => readFileSync(join(SRC, name), "utf8");

/** Un SVG rendu à `size` px de côté : la taille est posée sur l'élément racine, librsvg suit. */
function render(source, size) {
  const sized = source.replace("<svg ", `<svg width="${size}" height="${size}" `);
  return sharp(Buffer.from(sized)).resize(size, size);
}

const PNG = { compressionLevel: 9, adaptiveFiltering: true };

async function icon(out, source, size, { opaque = false } = {}) {
  let img = render(svg(source), size);
  // iOS attend un apple-touch-icon sans transparence : il arrondit les coins lui-même, et un coin
  // transparent devient noir chez lui.
  if (opaque) img = img.flatten({ background: "#0a0a0c" }).removeAlpha();
  await img.png(PNG).toFile(join(PUBLIC, out));
  console.log(out, `${size}x${size}`);
}

// Les SVG servis tels quels.
copyFileSync(join(SRC, "icon.svg"), join(PUBLIC, "icon.svg"));
copyFileSync(join(SRC, "icon-flat.svg"), join(PUBLIC, "icon-flat.svg"));
copyFileSync(join(SRC, "icon-32.svg"), join(PUBLIC, "favicon.svg"));
console.log("icon.svg, icon-flat.svg, favicon.svg (copiés)");

await icon("favicon-32.png", "icon-32.svg", 32);
await icon("icon-192.png", "icon.svg", 192);
await icon("icon-512.png", "icon.svg", 512);
await icon("icon-maskable-512.png", "icon-maskable.svg", 512, { opaque: true });
await icon("apple-touch-icon.png", "icon-flat.svg", 180, { opaque: true });
await icon("badge-96.png", "badge.svg", 96);

/**
 * Les écrans de lancement d'iOS : un par fichier déjà présent dans `public/splash/`, à ses
 * dimensions (le nom les porte : apple-splash-<largeur>-<hauteur>.png). Fond uni #0a0a0c — celui
 * du manifeste et de `layout.tsx` —, l'icône arrondie seule au centre, de 28 % du petit côté en
 * portrait comme en paysage (la proportion des écrans d'avant, mesurée sur les 42 fichiers).
 */
const SPLASH_BG = "#0a0a0c";
const SPLASH_RATIO = 0.28;
const splashDir = join(PUBLIC, "splash");
const names = readdirSync(splashDir).filter((n) => /^apple-splash-\d+-\d+\.png$/.test(n)).sort();
if (names.length === 0) throw new Error("aucun écran de lancement à régénérer dans public/splash");
const tiles = new Map();
for (const name of names) {
  const [w, h] = name.match(/(\d+)-(\d+)\.png$/).slice(1).map(Number);
  const size = Math.round(Math.min(w, h) * SPLASH_RATIO);
  if (!tiles.has(size)) tiles.set(size, await render(svg("icon.svg"), size).png().toBuffer());
  const out = await sharp({ create: { width: w, height: h, channels: 3, background: SPLASH_BG } })
    .composite([{ input: tiles.get(size), left: Math.round((w - size) / 2), top: Math.round((h - size) / 2) }])
    .removeAlpha()
    .png(PNG)
    .toBuffer();
  writeFileSync(join(splashDir, name), out);
}
console.log(`splash/ : ${names.length} écrans`);
