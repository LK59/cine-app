// Pose un `.br` à côté de chaque fichier texte du build. L'application sert ce jumeau quand le
// navigateur l'accepte (`src/lib/immersionFiles.ts`) : une route ne passe pas par la compression de
// Next, et le code de la page (three, Rapier) pèse plusieurs mégaoctets en clair.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const TEXT = new Set([".js", ".css", ".html", ".json", ".gltf", ".svg", ".wasm", ".bin", ".hdr"]);
let before = 0;
let after = 0;

// D'abord : ce qui est dans un paquet (`dist/packs/`, voir `assetPacks` dans vite.config.ts) sort du build. La page
// ne le demande plus un à un, et le garder doublerait le poids de l'image. Les dossiers vidés disparaissent avec.
const packsDir = path.join(dist, "packs");
let removed = 0;
for (const name of fs.existsSync(packsDir) ? fs.readdirSync(packsDir) : []) {
  const data = fs.readFileSync(path.join(packsDir, name));
  if (data.subarray(0, 4).toString("ascii") !== "LTPK") throw new Error(`paquet ${name} illisible`);
  const header = JSON.parse(data.subarray(8, 8 + data.readUInt32LE(4)).toString("utf8"));
  for (const file of Object.keys(header.files)) {
    if (file.includes("..")) throw new Error(`paquet ${name} : chemin refusé ${file}`);
    fs.rmSync(path.join(dist, file), { force: true });
    removed += 1;
  }
}
const prune = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) prune(path.join(dir, entry.name));
  if (dir !== dist && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
};
prune(dist);
console.log(`paquets : ${removed} fichiers retirés du build`);

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (TEXT.has(path.extname(entry.name)) && fs.statSync(full).size > 1024) {
      const raw = fs.readFileSync(full);
      const packed = zlib.brotliCompressSync(raw, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length },
      });
      // Un jumeau qui ne gagne presque rien (géométrie déjà compressée) ne vaut pas un fichier de plus.
      if (packed.length < raw.length * 0.9) {
        fs.writeFileSync(full + ".br", packed);
        before += raw.length;
        after += packed.length;
      }
    }
  }
}

walk(dist);
console.log(`brotli : ${(before / 1e6).toFixed(2)} Mo → ${(after / 1e6).toFixed(2)} Mo`);
