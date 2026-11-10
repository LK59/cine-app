// Reads the final sofa.gltf (meshopt) and writes sofa.json: per-mesh triangles + world bbox (glTF frame).
// Usage (inside immersion-assets-tools): node tools/sofa/verify.mjs public/assets/models/sofa/sofa.gltf <seatHeight>
import fs from "node:fs";
import { createRequire } from "node:module";
const req = createRequire("/opt/tools/");
const { NodeIO } = req("@gltf-transform/core");
const { ALL_EXTENSIONS } = req("@gltf-transform/extensions");
const { getBounds } = req("@gltf-transform/functions");
const { MeshoptDecoder } = req("meshoptimizer");
await MeshoptDecoder.ready;
const file = process.argv[2];
const seatHeight = Number(process.argv[3] || 0);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
const doc = await io.read(file);
const root = doc.getRoot();
const names = [], triangles = {}, bbox = {};
let all = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] };
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const n = mesh.getName();
  names.push(n);
  let t = 0;
  for (const p of mesh.listPrimitives()) t += p.getIndices().getCount() / 3;
  triangles[n] = t;
  const b = getBounds(node);
  bbox[n] = b;
  for (let i = 0; i < 3; i++) { all.min[i] = Math.min(all.min[i], b.min[i]); all.max[i] = Math.max(all.max[i], b.max[i]); }
  const attrs = mesh.listPrimitives()[0].listSemantics();
  console.log(n, "tris", t, "attrs", attrs.join(","), "mats", mesh.listPrimitives().map((p) => p.getMaterial()?.getName()).join(","),
    "nodeT", JSON.stringify(node.getTranslation()), "nodeS", JSON.stringify(node.getScale()));
}
// UV1 (lightmap) check: every primitive has TEXCOORD_0 and TEXCOORD_1, and no two triangles cover the
// same pixel centre of a 1024x1024 grid (rasterised); also the sum of triangle areas.
const R = 1024, cover = new Uint8Array(R * R);
let overlapPx = 0, area = 0, minU = 1e9, maxU = -1e9;
for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) {
  const sem = prim.listSemantics();
  if (!sem.includes("TEXCOORD_0") || !sem.includes("TEXCOORD_1")) throw new Error("missing UV set on " + mesh.getName() + ": " + sem);
  const uv = prim.getAttribute("TEXCOORD_1"), idx = prim.getIndices();
  const e = [0, 0];
  const get = (i) => { uv.getElement(i, e); return [e[0] * R, e[1] * R]; };
  for (let t = 0; t < idx.getCount(); t += 3) {
    const a = get(idx.getScalar(t)), b = get(idx.getScalar(t + 1)), c = get(idx.getScalar(t + 2));
    for (const q of [a, b, c]) { minU = Math.min(minU, q[0], q[1]); maxU = Math.max(maxU, q[0], q[1]); }
    const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    area += Math.abs(den) / 2;
    if (Math.abs(den) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(R - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(R - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const l1 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / den;
      const l2 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / den;
      const l3 = 1 - l1 - l2;
      if (l1 > 1e-6 && l2 > 1e-6 && l3 > 1e-6) { if (cover[y * R + x]++ === 1) overlapPx++; }
    }
  }
}
console.log("UV1 range px", minU.toFixed(1), maxU.toFixed(1), "triangle area / atlas", (area / (R * R)).toFixed(3), "pixels covered twice or more", overlapPx);
const r = (v) => Math.round(v * 1000) / 1000;
const out = {
  meshes: names, triangles, bbox: { min: all.min.map(r), max: all.max.map(r) },
  seatHeight, lightmapUv: "TEXCOORD_1", generator: "tools/sofa/build_sofa.py",
};
fs.writeFileSync(file.replace(/sofa\.gltf$/, "sofa.json"), JSON.stringify(out, null, 2) + "\n");
console.log("per-mesh bbox", JSON.stringify(Object.fromEntries(Object.entries(bbox).map(([k, b]) => [k, [b.min.map(r), b.max.map(r)]]))));
console.log("total", Object.values(triangles).reduce((a, b) => a + b, 0), "bbox", JSON.stringify(out.bbox));
