// Renders an SVG to PNG with the Chromium that ships in the mermaid-cli image — to look at the
// drawing, at a chosen width, or at one region of it.
//
// Usage: node preview.mjs <in.svg> <out.png> <width> [x y w h]
//   width       the PNG's width in pixels (the whole drawing, scaled)
//   x y w h     optional: a region of the drawing, in its own units, rendered at <width>
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("/home/mermaidcli/node_modules/");
const puppeteer = require("puppeteer");

const [input, output, widthArg, ...region] = process.argv.slice(2);
const width = Number(widthArg);
const svg = readFileSync(input, "utf8");
const vb = /viewBox="([^"]+)"/.exec(svg)[1].split(/\s+/).map(Number);
const [x, y, w, h] = region.length === 4 ? region.map(Number) : vb;
const height = Math.round((width * h) / w);

const browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium-browser", args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  // The drawing is placed so that the region fills the viewport exactly.
  const scale = width / w;
  const html = `<!doctype html><html><body style="margin:0;overflow:hidden;background:#fff">
<div style="position:absolute;left:${-(x - vb[0]) * scale}px;top:${-(y - vb[1]) * scale}px;width:${vb[2] * scale}px;height:${vb[3] * scale}px">
${svg.replace(/<svg\b([^>]*?)\swidth="[^"]*"([^>]*?)\sheight="[^"]*"/, '<svg$1 width="100%"$2 height="100%"')}
</div></body></html>`;
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: output, clip: { x: 0, y: 0, width, height } });
} finally {
  await browser.close();
}
console.log(`${output}: ${width}×${height}`);
