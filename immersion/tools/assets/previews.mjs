// Planches-contact de relecture : tools/assets/previews/{textures,models,hdris}.jpg
// Dans l'image immersion-assets-tools : node previews.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const sharp = createRequire("/opt/tools/")("sharp");
const ROOT = process.env.IMMERSION_ROOT || "/repo";
const T = path.join(ROOT, "tools/assets");
const SRC = path.join(ROOT, "assets-src");
const OUTM = path.join(ROOT, "public/assets/manifest.json");
const manifest = JSON.parse(fs.readFileSync(path.join(T, "manifest.json"), "utf8")).assets;
const built = fs.existsSync(OUTM) ? JSON.parse(fs.readFileSync(OUTM, "utf8")) : { assets: [] };
const sizes = Object.fromEntries(built.assets.map((a) => [a.id, a]));
const mb = (b) => (b / 1e6).toFixed(1) + " Mo";
const ex = (p) => fs.existsSync(p);

// Textures : le choix (étoile) puis ses deux alternatives, une ligne par besoin.
const rows = [];
for (const a of manifest.filter((x) => x.kind === "textures")) {
  const tiles = [];
  const pv = path.join(T, "previews/textures", a.id + ".jpg");
  tiles.push({ file: ex(pv) ? pv : path.join(SRC, a.slug, `diffuse_${a.resolution}.png`), label: `* ${a.id}`, sub: `${a.slug} (${a.resolution}) CHOIX`, mark: true });
  for (const s of a.alternates || []) {
    const f = path.join(SRC, "_alt", `${s}_diffuse_1k.jpg`);
    tiles.push({ file: ex(f) ? f : path.join(SRC, "_thumbs", `${s}.png`), label: `alt : ${s}`, sub: ex(f) ? "alternative" : "alternative (vignette sphère)" });
  }
  rows.push(tiles);
}
// Une planche à 3 colonnes par ligne : on aplatit en gardant l'ordre (choix, alt, alt).
const spec = (out, cols, tile, groups, extra = {}) => {
  const f = `/tmp/spec-${path.basename(out)}.json`;
  fs.writeFileSync(f, JSON.stringify({ out, cols, tile, groups, ...extra }));
  execFileSync("node", [path.join(T, "contact.mjs"), f], { stdio: "inherit" });
};
spec(path.join(T, "previews/textures.jpg"), 6, 300, [{ title: "Textures : choix (jaune, en premier de chaque paire de trois) puis 2 alternatives", tiles: rows.flat() }], { quality: 80 });

// Modèles : vignettes Poly Haven
const mt = manifest.filter((x) => x.kind === "model" && !x.skip).map((a) => ({
  file: path.join(SRC, "_thumbs", `${a.slug}.png`), label: a.id,
  sub: sizes[a.id] ? `${sizes[a.id].triangles} tri, ${mb(sizes[a.id].bytes)}` : "non construit",
}));
spec(path.join(T, "previews/models.jpg"), 6, 240, [{ title: "Modèles choisis (vignettes Poly Haven)", tiles: mt }], { quality: 82 });

// HDRI : ciel tonemappé, empilés
const ht = manifest.filter((x) => x.kind === "hdri").map((a) => {
  const p = path.join(SRC, a.slug, `${a.slug}_tonemapped.jpg`);
  return { file: p, label: a.id, sub: a.use + (sizes[a.id] ? ` - ${mb(sizes[a.id].bytes)}` : "") };
});
spec(path.join(T, "previews/hdris.jpg"), 1, 1024, [{ title: "HDRI (ciel tonemappé)", tiles: ht }], { tileW: 1024, tileH: 512, quality: 80 });
