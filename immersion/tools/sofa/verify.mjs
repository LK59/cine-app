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
const r = (v) => Math.round(v * 1000) / 1000;
const out = {
  meshes: names, triangles, bbox: { min: all.min.map(r), max: all.max.map(r) },
  seatHeight, generator: "tools/sofa/build_sofa.py",
};
fs.writeFileSync(file.replace(/sofa\.gltf$/, "sofa.json"), JSON.stringify(out, null, 2) + "\n");
console.log("per-mesh bbox", JSON.stringify(Object.fromEntries(Object.entries(bbox).map(([k, b]) => [k, [b.min.map(r), b.max.map(r)]]))));
console.log("total", Object.values(triangles).reduce((a, b) => a + b, 0), "bbox", JSON.stringify(out.bbox));
