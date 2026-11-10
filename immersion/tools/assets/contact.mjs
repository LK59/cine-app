// Planche-contact : node contact.mjs spec.json
// spec = { out, cols, tile, groups:[{title, tiles:[{file,label,sub,mark}]}] }
import fs from "node:fs";
import { createRequire } from "node:module";
const sharp = createRequire("/opt/tools/")("sharp"); // ESM ignore NODE_PATH
const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const { out, cols = 6, tile = 256 } = spec;
const pad = 10, labelH = 44, titleH = 40;
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
const W = cols * (tile + pad) + pad;
const comps = [];
let y = pad;
for (const g of spec.groups) {
  if (g.title) {
    comps.push({ input: Buffer.from(`<svg width="${W}" height="${titleH}"><text x="${pad}" y="28" font-family="sans-serif" font-size="22" font-weight="bold" fill="#fff">${esc(g.title)}</text></svg>`), left: 0, top: y });
    y += titleH;
  }
  let i = 0;
  for (const t of g.tiles) {
    const c = i % cols, r = Math.floor(i / cols);
    const x = pad + c * (tile + pad), yy = y + r * (tile + labelH + pad);
    try {
      const tw = spec.tileW ?? tile;
      const img = await sharp(t.file).resize(tw, spec.tileH ?? tile, { fit: "cover" }).jpeg({ quality: 88 }).toBuffer();
      comps.push({ input: img, left: x, top: yy });
    } catch (e) { console.error("tile fail", t.file, e.message); }
    const col = t.mark ? "#ffd24a" : "#ddd";
    comps.push({ input: Buffer.from(`<svg width="${tile}" height="${labelH}"><text x="2" y="16" font-family="sans-serif" font-size="14" font-weight="bold" fill="${col}">${esc(t.label)}</text><text x="2" y="34" font-family="sans-serif" font-size="12" fill="#aaa">${esc(t.sub)}</text></svg>`), left: x, top: yy + (spec.tileH ?? tile) });
    i++;
  }
  y += Math.ceil(g.tiles.length / cols) * ((spec.tileH ?? tile) + labelH + pad) + pad;
}
await sharp({ create: { width: W, height: y, channels: 3, background: "#15130f" } }).composite(comps).jpeg({ quality: spec.quality ?? 82 }).toFile(out);
console.log("ok", out, W, y);
