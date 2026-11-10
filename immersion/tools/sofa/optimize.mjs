// glTF optimisation: strip the placeholder textures Blender needs in order to export UV0, then
// dedup, prune, weld, reorder, quantize NORMAL/TEXCOORD_0 (positions stay float32 so the nodes
// carry no dequantization transform), and compress with EXT_meshopt_compression.
// Also writes the uncompressed, unquantized baking copy (same vertex data and order as the final file).
// Usage (inside immersion-assets-tools): node tools/sofa/optimize.mjs <in.gltf> <out.gltf> <bake.glb>
import { createRequire } from "node:module";
const req = createRequire("/opt/tools/");
const { NodeIO } = req("@gltf-transform/core");
const { ALL_EXTENSIONS, EXTMeshoptCompression } = req("@gltf-transform/extensions");
const { dedup, prune, weld, reorder, quantize } = req("@gltf-transform/functions");
const { MeshoptEncoder, MeshoptDecoder } = req("meshoptimizer");
await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
const [inp, out, bake] = process.argv.slice(2);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder,
});
const doc = await io.read(inp);
const root = doc.getRoot();
// Placeholder colours (the app assigns its own PBR materials by mesh name).
const COLOURS = { sofa_frame: [0.70, 0.62, 0.50], sofa_cushions: [0.74, 0.66, 0.54], pillows_a: [0.50, 0.40, 0.32], pillows_b: [0.60, 0.60, 0.55] };
for (const mesh of root.listMeshes()) {
  for (const p of mesh.listPrimitives()) {
    const m = p.getMaterial();
    if (!m) continue;
    m.setName(mesh.getName() + "_placeholder").setBaseColorTexture(null).setEmissiveTexture(null).setEmissiveFactor([0, 0, 0])
      .setBaseColorFactor([...(COLOURS[mesh.getName()] || [0.7, 0.7, 0.7]), 1]).setDoubleSided(false);
  }
}
for (const t of root.listTextures()) t.dispose();
await doc.transform(
  dedup(), prune({ keepAttributes: true }), weld(),
  reorder({ encoder: MeshoptEncoder, target: "size" }),
);
// baking copy: everything the final file has, before quantization and compression
if (bake) await new NodeIO().registerExtensions(ALL_EXTENSIONS).write(bake, doc);
await doc.transform(
  quantize({ pattern: /^(NORMAL|TEXCOORD_0|TEXCOORD_1)$/, quantizeNormal: 10, quantizeTexcoord: 14 }),
);
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({
  method: EXTMeshoptCompression.EncoderMethod.QUANTIZE,
});
// one stable buffer name -> sofa.bin
for (const b of root.listBuffers()) b.setURI("sofa.bin");
await io.write(out, doc);
