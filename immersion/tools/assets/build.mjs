// Convertit assets-src/ en public/assets/ (à lancer dans l'image immersion-assets-tools).
// node build.mjs [--only id,id] [--force] [--jobs N]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
const sharp = createRequire("/opt/tools/")("sharp"); // ESM ignore NODE_PATH
const run = promisify(execFile);

const ROOT = process.env.IMMERSION_ROOT || "/repo";
const SRC = path.join(ROOT, "assets-src");
const OUT = path.join(ROOT, "public/assets");
const PREV = path.join(ROOT, "tools/assets/previews");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/assets/manifest.json"), "utf8")).assets;
const args = process.argv.slice(2);
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1].split(",")) : null;
const force = args.includes("--force");
const CONC = Number(args.includes("--jobs") ? args[args.indexOf("--jobs") + 1] : 2);

const sh = async (cmd, a) => {
  try { return (await run(cmd, a, { maxBuffer: 1 << 28 })).stdout; }
  catch (e) { throw new Error(`${cmd} ${a.join(" ")}\n${e.stderr || e.message}`); }
};
const exists = (p) => fs.existsSync(p) && fs.statSync(p).size > 0;
const mk = (p) => fs.mkdirSync(p, { recursive: true });
const walk = (d, base = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name), base) : [path.relative(base, path.join(d, e.name))]);

// ---------- textures ----------
// La puissance de deux la plus proche. Certaines textures de la source ne sont pas carrées au pixel
// près (1024 × 1045, 1024 × 1009) : compressée par blocs avec ses mipmaps et répétée, une telle
// image n'est pas acceptée par la carte graphique — la matière sortait noire.
const pot = (n) => 2 ** Math.round(Math.log2(n));

// 8 bits, 3 canaux, dimensions en puissances de deux, quel que soit le format d'origine (PNG 16 bits,
// gris, alpha, hauteur de travers...).
async function toRgb8(file, dest) {
  const meta = await sharp(file).metadata();
  const size = { width: pot(meta.width), height: pot(meta.height) };
  const { data, info } = await sharp(file).removeAlpha().resize({ ...size, fit: "fill" }).toColourspace("srgb").raw({ depth: "uchar" }).toBuffer({ resolveWithObject: true });
  await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png({ compressionLevel: 1 }).toFile(dest);
  return info;
}
const find = (dir, name) => fs.readdirSync(dir).find((f) => f.startsWith(name + "_") && /\.(png|jpg)$/.test(f));

async function packArm(dir, dest) {
  const ch = async (name, fallback) => {
    const f = find(dir, name);
    if (!f) return null;
    const meta = await sharp(path.join(dir, f)).metadata();
    return sharp(path.join(dir, f)).removeAlpha().resize({ width: pot(meta.width), height: pot(meta.height), fit: "fill" }).toColourspace("b-w").raw({ depth: "uchar" }).toBuffer({ resolveWithObject: true });
  };
  const ao = await ch("ao"), ro = await ch("rough"), me = await ch("metal");
  const ref = ao || ro || me;
  if (!ref) throw new Error("ni arm ni ao/rough/metal");
  const { width, height } = ref.info, n = width * height;
  const buf = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    buf[i * 3] = ao ? ao.data[i] : 255;
    buf[i * 3 + 1] = ro ? ro.data[i] : 255;
    buf[i * 3 + 2] = me ? me.data[i] : 0;
  }
  await sharp(buf, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 1 }).toFile(dest);
}

async function buildTexture(a) {
  const dir = path.join(SRC, a.slug), out = path.join(OUT, a.out), res = a.resolution;
  const files = ["color", "normal", "arm"].map((n) => path.join(out, n + ".ktx2"));
  const prev = path.join(PREV, "textures", a.id + ".jpg");
  if (!force && files.every(exists) && exists(prev)) return;
  mk(out); mk(path.dirname(prev));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tex-"));
  try {
    const diff = path.join(tmp, "d.png"), nor = path.join(tmp, "n.png"), arm = path.join(tmp, "a.png");
    await toRgb8(path.join(dir, find(dir, "diffuse")), diff);
    await toRgb8(path.join(dir, find(dir, "nor_gl")), nor);
    if (find(dir, "arm")) await toRgb8(path.join(dir, find(dir, "arm")), arm); else await packArm(dir, arm);
    const common = ["--generate-mipmap", "--mipmap-wrap", "wrap", "--threads", "3"];
    const enc = (flags, i, o) => sh("ktx", ["create", ...flags, ...common, i, o]);
    // Budget de poids : la normale reste en UASTC (RDO fort) pour les surfaces 2k ; en 1k elle passe en ETC1S q255.
    const nUastc = res === "2k";
    await Promise.all([
      enc(["--format", "R8G8B8_SRGB", "--encode", "basis-lz", "--qlevel", "220", "--clevel", "4", "--assign-tf", "srgb"], diff, files[0]),
      nUastc
        ? enc(["--format", "R8G8B8_UNORM", "--encode", "uastc", "--uastc-quality", "2", "--uastc-rdo", "--uastc-rdo-l", "2", "--zstd", "18", "--assign-tf", "linear"], nor, files[1])
        : enc(["--format", "R8G8B8_UNORM", "--encode", "basis-lz", "--qlevel", "255", "--clevel", "4", "--assign-tf", "linear"], nor, files[1]),
      enc(["--format", "R8G8B8_UNORM", "--encode", "basis-lz", "--qlevel", "200", "--clevel", "3", "--assign-tf", "linear"], arm, files[2]),
    ]);
    // Une normale UASTC 2k qui dépasse 2,5 Mo est réencodée en ETC1S qualité 255 (budget de poids).
    if (nUastc && fs.statSync(files[1]).size > 2.5e6) {
      await enc(["--format", "R8G8B8_UNORM", "--encode", "basis-lz", "--qlevel", "255", "--clevel", "4", "--assign-tf", "linear"], nor, files[1]);
      console.log(`  ${a.id}: normal en ETC1S q255`);
    }
    await sharp(diff).resize(512, 512, { fit: "cover" }).jpeg({ quality: 82 }).toFile(prev);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---------- modèles ----------
// Nombre de triangles d'un glTF, lu par gltf-transform inspect (décode meshopt).
async function triangles(file) {
  const out = await sh("gltf-transform", ["inspect", file, "--format", "csv"]);
  const sec = out.split("MESHES")[1]?.split("MATERIALS")[0] ?? "";
  let tris = 0;
  const cols = (l) => [...l.matchAll(/"[^"]*"|[^,]+|(?<=,)(?=,)/g)].map((m) => m[0]);
  for (const line of sec.split("\n")) {
    // colonnes : #,name,mode,meshPrimitives,glPrimitives,vertices,indices,attributes,instances,size
    const c = cols(line);
    if (/^\d+$/.test(c[0] ?? "") && c[2] === "TRIANGLES") tris += Number(c[4]) * Number(c[8]);
  }
  return tris;
}

// Poly Haven fournit l'opacité des feuillages à part, hors du glTF : on la fond dans l'alpha
// de la couleur et on passe le matériau en alpha testé (MASK).
async function injectAlpha(glb, dir, a) {
  const { NodeIO } = createRequire("/opt/tools/")("@gltf-transform/core");
  const { ALL_EXTENSIONS } = createRequire("/opt/tools/")("@gltf-transform/extensions");
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(glb);
  for (const [mat, key] of Object.entries(a.alphaMaps)) {
    const m = doc.getRoot().listMaterials().find((x) => x.getName() === mat);
    const tex = m?.getBaseColorTexture();
    if (!tex) throw new Error("matériau/texture introuvable : " + mat);
    const f = fs.readdirSync(path.join(dir, "extra")).find((n) => n.startsWith(key + "_"));
    const { data: rgbRaw, info } = await sharp(Buffer.from(tex.getImage())).removeAlpha().toColourspace("srgb").raw({ depth: "uchar" }).toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    const alpha = await sharp(path.join(dir, "extra", f)).resize(width, height).toColourspace("b-w").extractChannel(0).raw().toBuffer();
    const png = await sharp(rgbRaw, { raw: { width, height, channels: 3 } }).joinChannel(alpha, { raw: { width, height, channels: 1 } }).png({ compressionLevel: 1 }).toBuffer();
    tex.setImage(new Uint8Array(png)).setMimeType("image/png");
    m.setAlphaMode("MASK").setAlphaCutoff(0.5).setDoubleSided(true);
  }
  await io.write(glb, doc);
}

async function buildModel(a) {
  const dir = path.join(SRC, a.slug), out = path.join(OUT, a.out);
  const final = path.join(out, a.id + ".gltf");
  if (!force && exists(final)) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mdl-"));
  const gt = (...x) => sh("gltf-transform", x);
  try {
    const size = String(a.textureSize || 1024), jobs = "2";
    let cur = path.join(tmp, "0.glb");
    await gt("copy", path.join(dir, a.slug + ".gltf"), cur);
    if (a.alphaMaps) await injectAlpha(cur, dir, a);
    const step = async (name, ...x) => { const n = path.join(tmp, name + ".glb"); await gt(name === "dedup2" ? "dedup" : name, cur, n, ...x); cur = n; };
    await step("dedup"); await step("prune"); await step("weld");
    let tris = await triangles(cur);
    const info = { trisSource: tris };
    if (a.maxTriangles && tris > a.maxTriangles) {
      let ratio = (a.maxTriangles / tris) * 0.95, error = 0.01, best = cur;
      const base = cur;
      for (let i = 0; i < 6; i++) {
        const n = path.join(tmp, `s${i}.glb`);
        await gt("simplify", base, n, "--ratio", String(ratio), "--error", String(error));
        const t = await triangles(n);
        info.simplifyTries = (info.simplifyTries || 0) + 1;
        best = n; tris = t;
        if (t <= a.maxTriangles) break;
        ratio = Math.max(0.0005, ratio * (a.maxTriangles / t) * 0.9); error = Math.min(1, error * 5);
      }
      cur = best;
      await step("prune");
      tris = await triangles(cur);
    }
    info.tris = tris;
    await step("resize", "--width", size, "--height", size);
    // Budget de poids : la normale reste en UASTC (RDO fort) si le manifeste demande `normalCodec: "uastc"` ; par défaut ETC1S q255 (budget de poids) ; l'ORM passe en ETC1S avec la couleur.
    if (a.normalCodec === "uastc") await step("uastc", "--slots", "normalTexture", "--level", "2", "--rdo", "--rdo-lambda", "2", "--zstd", "18", "--jobs", jobs);
    else await step("etc1s", "--slots", "normalTexture", "--quality", "255", "--compression", "3", "--jobs", jobs);
    await step("etc1s", "--quality", "176", "--compression", "3", "--jobs", jobs);
    await step("meshopt", "--level", "high");
    fs.rmSync(out, { recursive: true, force: true }); mk(out);
    await gt("copy", cur, final);
    // Vérifie que le résultat se relit (meshopt + KTX2) et que rien n'est embarqué.
    const g = JSON.parse(fs.readFileSync(final, "utf8"));
    const emb = [...(g.buffers || []), ...(g.images || [])].filter((x) => !x.uri || x.uri.startsWith("data:"));
    if (emb.length) throw new Error("ressource embarquée dans " + final);
    const finalTris = await triangles(final);
    if (!finalTris) throw new Error("aucun triangle dans " + final);
    fs.writeFileSync(path.join(tmp, "ok"), "");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---------- HDRI ----------
async function buildHdri(a) {
  const dir = path.join(SRC, a.slug), hdr = path.join(OUT, "hdri", a.id + ".hdr"), bg = path.join(OUT, "hdri", a.id + "_bg.jpg");
  if (!force && exists(hdr) && (exists(bg) || !find2(dir, "tonemapped"))) return;
  mk(path.join(OUT, "hdri"));
  fs.copyFileSync(path.join(dir, `${a.slug}_${a.resolution}.hdr`), hdr);
  const t = find2(dir, "tonemapped");
  if (t) await sharp(path.join(dir, t)).resize({ width: a.bgWidth || 4096 }).jpeg({ quality: 80, mozjpeg: true }).toFile(bg);
}
const find2 = (dir, n) => fs.readdirSync(dir).find((f) => f.includes(n) && f.endsWith(".jpg"));

// ---------- pool + manifeste de sortie ----------
const todo = manifest.filter((a) => !a.skip && !a.contactOnly && (!only || only.has(a.id)));
const failed = [];
let next = 0;
async function worker() {
  while (next < todo.length) {
    const a = todo[next++];
    const t0 = Date.now();
    try {
      await { textures: buildTexture, model: buildModel, hdri: buildHdri }[a.kind](a);
      console.log(`ok ${a.id} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (e) { failed.push(a.id); console.error(`ÉCHEC ${a.id}: ${e.message}`); }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

const entries = [];
let total = 0;
// Sorties devenues inutiles (asset retiré du manifeste) : supprimées.
const keep = new Set(manifest.filter((x) => !x.skip && !x.contactOnly).map((x) => x.id));
for (const [dir, strip] of [["models", (n) => n], ["hdri", (n) => n.replace(/(_bg\.jpg|\.hdr)$/, "")], ["textures", (n) => n]]) {
  const d = path.join(OUT, dir);
  if (fs.existsSync(d)) for (const n of fs.readdirSync(d)) if (!keep.has(strip(n))) fs.rmSync(path.join(d, n), { recursive: true, force: true });
}
for (const a of manifest.filter((x) => !x.skip && !x.contactOnly)) {
  const base = a.kind === "hdri" ? path.join(OUT, "hdri") : path.join(OUT, a.out);
  if (!fs.existsSync(base)) continue;
  let files = a.kind === "hdri"
    ? [a.id + ".hdr", a.id + "_bg.jpg"].filter((f) => exists(path.join(base, f))).map((f) => "hdri/" + f)
    : walk(base).sort().map((f) => path.posix.join(a.out, f.split(path.sep).join("/")));
  const list = files.map((f) => ({ path: f, bytes: fs.statSync(path.join(OUT, f)).size }));
  const e = { id: a.id, kind: a.kind, slug: a.slug, files: list, bytes: list.reduce((s, f) => s + f.bytes, 0) };
  if (a.kind === "model") e.triangles = await triangles(path.join(OUT, a.out, a.id + ".gltf"));
  total += e.bytes; entries.push(e);
}
const out = { totalBytes: total, assets: entries };
mk(OUT);
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(out, null, 1));
console.log(`manifeste : ${entries.length} assets, ${(total / 1e6).toFixed(1)} MB`);
if (failed.length) { console.error("échecs :", failed.join(", ")); process.exit(1); }
