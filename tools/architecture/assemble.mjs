// Assembles ARCHITECTURE.svg: a title band, then rows of zones — each a coloured panel holding its
// heading, the prose that follows the diagram in DOC-TECH.md, and the Mermaid drawing(s) rendered by
// mmdc — plus a legend. Plain Node, no dependency: run by build.sh inside the mermaid-cli image.
//
// Usage: node assemble.mjs <build folder> <package.json> <out.svg>
//
// What to change where:
//   - a box, an arrow, a paragraph → DOC-TECH.md, « Application map » (never this file);
//   - which zones share a row, the colours, the legend → ROWS, COLOURS, legend() below.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [build, pkgPath, out] = process.argv.slice(2);
if (!build || !pkgPath || !out) {
  console.error("usage: node assemble.mjs <build folder> <package.json> <out.svg>");
  process.exit(2);
}

const PAGE_W = 8000;
const MARGIN = 80;
const GAP = 60; // between panels, horizontally and vertically
const PAD = 48; // inside a panel
const LEGEND_W = 1180;
const FONT = "-apple-system, system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** Zone number → colour of its band (zone 3 spans two panels). */
const COLOURS = { 1: "#2563eb", 2: "#7c3aed", 3: "#059669", 4: "#db2777", 5: "#0891b2", 6: "#65a30d", 7: "#dc2626", 8: "#d97706" };

/**
 * The page, row by row. A panel stacks its diagrams vertically; every diagram of a row is drawn at
 * the same scale (at most `cap`), chosen so the row fills the page's width.
 * Sizes measured on 19/11/2026: 1 is wide and fills a row with the legend, 2 and 8 are long and low,
 * 3c is a wide strip that sits under 3b, and 3a is about as tall as 3b + 3c.
 */
const ROWS = [
  { cap: 1.15, panels: [{ zone: "1", diagrams: ["1"] }, { legend: true }] },
  { cap: 1.1, panels: [{ zone: "2", diagrams: ["2"] }] },
  { cap: 1.1, panels: [{ zone: "3", diagrams: ["3a"] }, { zone: "3", diagrams: ["3b", "3c"], continued: true }] },
  { cap: 1.2, panels: [{ zone: "4", diagrams: ["4"] }, { zone: "5", diagrams: ["5"] }] },
  { cap: 1.1, panels: [{ zone: "6", diagrams: ["6"] }, { zone: "7", diagrams: ["7"] }] },
  { cap: 1.2, panels: [{ zone: "8", diagrams: ["8"] }] },
];

const zones = JSON.parse(readFileSync(join(build, "zones.json"), "utf8"));
const byKey = Object.fromEntries(zones.map((z) => [z.key, z]));
const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
const today = process.env.MAP_DATE || new Date().toISOString().slice(0, 10);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Greedy word wrap on an estimated glyph width (system sans: about half the font size on average). */
function wrap(text, fontSize, width) {
  const max = Math.max(10, Math.floor(width / (fontSize * 0.52)));
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && (line + " " + word).length > max) {
      lines.push(line);
      line = word;
    } else line = line ? line + " " + word : word;
  }
  if (line) lines.push(line);
  return lines;
}

/** A rendered diagram: its viewBox, and its content with every id made unique to it. */
function diagram(key) {
  const z = byKey[key];
  if (!z) throw new Error(`no diagram « ${key} » in zones.json`);
  const id = "z" + z.file.replace(".mmd", "");
  let svg = readFileSync(join(build, z.file.replace(".mmd", ".svg")), "utf8");
  const root = /<svg\b[^>]*>/.exec(svg)[0];
  const vb = /viewBox="([^"]+)"/.exec(root)[1].split(/\s+/).map(Number);
  let body = svg.slice(svg.indexOf(root) + root.length, svg.lastIndexOf("</svg>"));
  // Ids prefixed (the root's stays: Mermaid's CSS is scoped by it), and every reference with them.
  body = body
    .replace(/\bid="([^"]+)"/g, (_, v) => `id="${id}-${v}"`)
    .replace(/url\(#([^)]+)\)/g, (_, v) => `url(#${id}-${v})`)
    .replace(/(xlink:href|href)="#([^"]+)"/g, (_, a, v) => `${a}="#${id}-${v}"`);
  return { key, id, vb, body, heading: z.heading, prose: z.prose };
}

const zoneTitle = { 1: "The system", 2: "The two interfaces", 3: "The player", 4: "The life of one playback", 5: "Data flow and caches", 6: "Logs and observability", 7: "Requests and security", 8: "Optional features" };
for (const z of zones) if (/^\d+$/.test(z.key)) zoneTitle[z.key] = z.heading;

const parts = [];
let y = MARGIN;

// Title band.
const BAND_H = 330;
parts.push(`<g font-family="${FONT}">
<rect x="${MARGIN}" y="${y}" width="${PAGE_W - 2 * MARGIN}" height="${BAND_H}" rx="28" fill="#0f172a"/>
<text x="${MARGIN + 64}" y="${y + 130}" font-size="92" font-weight="700" fill="#ffffff">Laterna — application map</text>
<text x="${MARGIN + 64}" y="${y + 200}" font-size="34" fill="#cbd5e1">Version ${esc(version)} · ${today} · one page, eight zones, from the widest view to the finest</text>
<text x="${MARGIN + 64}" y="${y + 256}" font-size="26" fill="#94a3b8">Every box names the file, route or function that carries it, so the map doubles as an index into the code. Reasons live in DOC-TECH.md, DECISIONS.md and CLAUDE.md.</text>
<text x="${MARGIN + 64}" y="${y + 296}" font-size="26" fill="#94a3b8">Vector drawing: zoom freely. Self-hosted media front end with its own in-browser player (Lumen) — Next.js, React, TypeScript, SQLite — over Jellyfin, Radarr, Sonarr, Jellyseerr, qBittorrent, Bazarr, Jackett.</text>
${Object.entries(zoneTitle)
  .map(([n, t], i) => {
    const cx = 5700 + (i % 2) * 1000;
    const cy = y + 70 + Math.floor(i / 2) * 58;
    return `<rect x="${cx}" y="${cy}" width="40" height="40" rx="10" fill="${COLOURS[n]}"/><text x="${cx + 20}" y="${cy + 29}" font-size="24" font-weight="700" fill="#fff" text-anchor="middle">${n}</text><text x="${cx + 56}" y="${cy + 30}" font-size="26" fill="#e2e8f0">${esc(t)}</text>`;
  })
  .join("\n")}
</g>`);
y += BAND_H + GAP;

function legend(x, top, h) {
  const L = [];
  const lx = x + 48;
  const tx = x + 278;
  L.push(`<rect x="${x}" y="${top}" width="${LEGEND_W}" height="${h}" rx="24" fill="#ffffff" stroke="#334155" stroke-width="4"/>`);
  L.push(`<path d="M${x + 24},${top} h${LEGEND_W - 48} a24,24 0 0 1 24,24 v96 h-${LEGEND_W} v-96 a24,24 0 0 1 24,-24 z" fill="#334155"/>`);
  L.push(`<text x="${lx}" y="${top + 62}" font-size="44" font-weight="700" fill="#fff">Legend</text><text x="${lx}" y="${top + 100}" font-size="26" fill="#e2e8f0">How to read the drawings</text>`);
  let ly = top + 170;
  const head = (t) => {
    L.push(`<text x="${lx}" y="${ly}" font-size="24" font-weight="700" fill="#334155" letter-spacing="1.5">${t}</text>`);
    ly += 26;
  };
  const row = (shape, title, sub) => {
    L.push(shape(ly));
    L.push(`<text x="${tx}" y="${ly + 34}" font-size="26" fill="#111827">${esc(title)}</text><text x="${tx}" y="${ly + 66}" font-size="21" fill="#475569">${esc(sub)}</text>`);
    ly += 108;
  };
  const arrow = (dash) => (yy) =>
    `<line x1="${lx}" y1="${yy + 26}" x2="${lx + 190}" y2="${yy + 26}" stroke="#475569" stroke-width="3"${dash ? ` stroke-dasharray="${dash}"` : ""}/><path d="M${lx + 190},${yy + 16} L${lx + 208},${yy + 26} L${lx + 190},${yy + 36} z" fill="#475569"/>`;
  head("SHAPES");
  row((yy) => `<rect x="${lx}" y="${yy}" width="200" height="56" rx="4" fill="#eef2ff" stroke="#6366f1" stroke-width="2"/>`, "Component, file, route or function", "what the box names is where it lives in the code");
  row((yy) => `<path d="M${lx},${yy + 10} a100,10 0 0 0 200,0 a100,10 0 0 0 -200,0 v40 a100,10 0 0 0 200,0 v-40" fill="#eef2ff" stroke="#6366f1" stroke-width="2"/>`, "Store", "database, log file, browser storage, cache");
  row((yy) => `<path d="M${lx + 100},${yy - 4} L${lx + 160},${yy + 28} L${lx + 100},${yy + 60} L${lx + 40},${yy + 28} z" fill="#eef2ff" stroke="#6366f1" stroke-width="2"/>`, "Decision", "each outgoing arrow is labelled with its answer");
  row((yy) => `<rect x="${lx}" y="${yy - 4}" width="200" height="64" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/><text x="${lx + 100}" y="${yy + 20}" font-size="17" fill="#070503" text-anchor="middle">Group title</text>`, "Group", "a place (browser, container) or a family of files");
  ly += 20;
  head("ARROWS");
  row(arrow(null), "Call, request or data flow", "solid: happens on the normal path");
  row(arrow("7 6"), "Occasional, asynchronous or side effect", "dotted: a push, a fallback, a background task, a hint");
  row((yy) => arrow(null)(yy) + `<rect x="${lx + 60}" y="${yy + 12}" width="80" height="28" fill="#fff"/><text x="${lx + 100}" y="${yy + 33}" font-size="19" fill="#111827" text-anchor="middle">label</text>`, "Labelled arrow", "the label says what travels, or when");
  row((yy) => `<line x1="${lx}" y1="${yy + 26}" x2="${lx + 208}" y2="${yy + 26}" stroke="#475569" stroke-width="3"/>`, "Plain line", "uses, or kept beside");
  row(arrow("4 5"), "Sequence reply (zone 4)", "solid arrow: a call · dashed: its answer");
  ly += 20;
  head("ZONES");
  for (const [n, t] of Object.entries(zoneTitle)) {
    L.push(`<rect x="${lx}" y="${ly}" width="44" height="44" rx="10" fill="${COLOURS[n]}"/><text x="${lx + 22}" y="${ly + 32}" font-size="26" font-weight="700" fill="#fff" text-anchor="middle">${n}</text><text x="${lx + 64}" y="${ly + 32}" font-size="26" fill="#111827">${esc(t)}</text>`);
    ly += 58;
  }
  ly += 40;
  head("READING");
  ly += 26;
  const reading =
    "Start at zone 1 for the whole system, then follow a viewer: the interfaces (2), the player — its native path, its safety net and casting (3), one playback end to end (4), what is cached where (5), what is written down (6), what the gate lets through (7), and the optional features (8). Boxes named « section 3 » or « 3b » refer to zone 3.";
  for (const line of wrap(reading, 23, LEGEND_W - 96)) {
    L.push(`<text x="${lx}" y="${ly}" font-size="23" fill="#334155">${esc(line)}</text>`);
    ly += 34;
  }
  return `<g font-family="${FONT}">${L.join("\n")}</g>`;
}

const CAPTION_H = 56;
const PROSE_SIZE = 24;
const PROSE_LH = 34;
const HEAD_H = 120;

for (const row of ROWS) {
  const panels = row.panels.map((p) => (p.legend ? p : { ...p, ds: p.diagrams.map(diagram) }));
  const drawn = panels.filter((p) => !p.legend);
  const natural = (p) => Math.max(...p.ds.map((d) => d.vb[2]));
  const fixed = panels.filter((p) => p.legend).length * LEGEND_W + GAP * (panels.length - 1) + 2 * PAD * drawn.length;
  const avail = PAGE_W - 2 * MARGIN - fixed;
  const totalNatural = drawn.reduce((s, p) => s + natural(p), 0);
  const scale = Math.min(row.cap, avail / totalNatural);
  // What the cap leaves over widens the panels in proportion; the drawings stay centred.
  const extra = avail - totalNatural * scale;
  for (const p of drawn) {
    p.inner = natural(p) * scale + (extra * natural(p)) / totalNatural;
    p.width = p.inner + 2 * PAD;
    const many = p.ds.length > 1 || /[a-z]$/.test(p.ds[0].key);
    p.captions = many;
    p.prose = p.ds.map((d) => d.prose).filter(Boolean).join(" ");
    p.lines = wrap(p.prose, PROSE_SIZE, p.inner);
    p.height = HEAD_H + 40 + p.lines.length * PROSE_LH + 30 + p.ds.reduce((s, d) => s + d.vb[3] * scale + (many ? CAPTION_H : 0) + 20, 0) + PAD;
  }
  const rowH = Math.max(...drawn.map((p) => p.height));
  let x = MARGIN;
  for (const p of panels) {
    if (p.legend) {
      parts.push(legend(x, y, rowH));
      x += LEGEND_W + GAP;
      continue;
    }
    const colour = COLOURS[p.zone];
    const zt = zoneTitle[p.zone];
    const sub = p.continued ? "continued" : p.ds[0].key === "3a" ? "src/lib/webcodecs/ and the hosts around it" : "";
    const g = [];
    g.push(`<rect x="${x}" y="${y}" width="${p.width}" height="${rowH}" rx="24" fill="#ffffff" stroke="${colour}" stroke-width="4"/>`);
    g.push(`<path d="M${x + 24},${y} h${p.width - 48} a24,24 0 0 1 24,24 v${HEAD_H - 24} h-${p.width} v-${HEAD_H - 24} a24,24 0 0 1 24,-24 z" fill="${colour}"/>`);
    g.push(`<text x="${x + PAD}" y="${y + 66}" font-size="46" font-weight="700" fill="#fff">${esc(p.zone)} · ${esc(zt)}${sub ? ` <tspan font-size="30" font-weight="400" fill-opacity="0.9">— ${esc(sub)}</tspan>` : ""}</text>`);
    let yy = y + HEAD_H + 40 + 24;
    for (const line of p.lines) {
      g.push(`<text x="${x + PAD}" y="${yy}" font-size="${PROSE_SIZE}" fill="#1f2937">${esc(line)}</text>`);
      yy += PROSE_LH;
    }
    g.push(`<line x1="${x + PAD}" x2="${x + p.width - PAD}" y1="${yy - 8}" y2="${yy - 8}" stroke="#e5e7eb" stroke-width="2"/>`);
    yy += 22;
    for (const d of p.ds) {
      if (p.captions) {
        g.push(`<text x="${x + PAD}" y="${yy + 34}" font-size="30" font-weight="700" fill="${colour}">${esc(d.key)} · ${esc(d.heading)}</text>`);
        yy += CAPTION_H;
      }
      const w = d.vb[2] * scale;
      const h = d.vb[3] * scale;
      const dx = x + PAD + (p.inner - w) / 2;
      g.push(`<svg x="${dx}" y="${yy}" width="${w}" height="${h}" viewBox="${d.vb.join(" ")}" id="${d.id}">${d.body}</svg>`);
      yy += h + 20;
    }
    parts.push(`<g font-family="${FONT}">${g.join("\n")}</g>`);
    x += p.width + GAP;
  }
  y += rowH + GAP;
}

parts.push(`<text x="${PAGE_W / 2}" y="${y + 30}" font-family="${FONT}" font-size="24" fill="#64748b" text-anchor="middle">Generated from the « Application map » diagrams of DOC-TECH.md by tools/architecture/build.sh — change the diagrams there, then rebuild; never edit this file by hand.</text>`);
const PAGE_H = Math.ceil(y + 90);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${PAGE_W}" height="${PAGE_H}" viewBox="0 0 ${PAGE_W} ${PAGE_H}" role="img" aria-labelledby="map-title">
<title id="map-title">Laterna — application map</title>
<style>.edgeLabel rect{opacity:0.92 !important}</style>
<rect x="0" y="0" width="${PAGE_W}" height="${PAGE_H}" fill="#f1f5f9"/>
${parts.join("\n")}
</svg>
`;
writeFileSync(out, svg);
console.log(`${out}: ${PAGE_W}×${PAGE_H}, ${zones.length} diagrams`);
