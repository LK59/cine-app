// Reads the « Application map » section of DOC-TECH.md and writes, into the build folder, one
// Mermaid file per diagram (NN.mmd) and zones.json: each diagram's key (« 1 », « 3a »…), heading, and
// the first paragraph that follows it (the prose shown under the zone title in ARCHITECTURE.svg).
//
// The map is the single source: the drawing is never edited by hand, so it cannot drift from the
// diagrams again (the first ARCHITECTURE.svg, 13/10/2026, was assembled once and nothing rebuilt it).
//
// Usage: node extract.mjs <DOC-TECH.md> <build folder>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [doc, out] = process.argv.slice(2);
if (!doc || !out) {
  console.error("usage: node extract.mjs <DOC-TECH.md> <build folder>");
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const text = readFileSync(doc, "utf8");
const start = text.indexOf("\n## Application map");
if (start < 0) throw new Error("« ## Application map » not found");
// The section ends at the next level-2 heading or the horizontal rule that closes it.
const rest = text.slice(start + 1);
const endMatch = /\n(## (?!Application map)|---\n)/.exec(rest);
const section = endMatch ? rest.slice(0, endMatch.index) : rest;
const lines = section.split("\n");

/** Markdown inline → plain text: links, code, emphasis. */
function plain(s) {
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const zones = [];
let heading = null;
let n = 0;
for (let i = 0; i < lines.length; i++) {
  const h = /^#{3,4} (.+)$/.exec(lines[i]);
  if (h) heading = h[1].trim();
  if (lines[i].trim() !== "```mermaid") continue;
  const body = [];
  i++;
  while (i < lines.length && lines[i].trim() !== "```") body.push(lines[i++]);
  // The first paragraph after the block, up to its « Details: » pointer (links that mean nothing
  // on a drawing).
  let j = i + 1;
  while (j < lines.length && lines[j].trim() === "") j++;
  const para = [];
  while (j < lines.length && lines[j].trim() !== "" && !/^#{2,4} /.test(lines[j]) && !lines[j].startsWith("```")) para.push(lines[j++]);
  let prose = plain(para.join(" "));
  const cut = prose.search(/ Details: /);
  if (cut >= 0) prose = prose.slice(0, cut);
  const key = (/^(\d+[a-z]?)\. /.exec(heading ?? "") ?? [])[1];
  if (!key) throw new Error(`diagram ${n + 1} has no numbered heading (got « ${heading} »)`);
  n++;
  const file = `${String(n).padStart(2, "0")}.mmd`;
  writeFileSync(join(out, file), body.join("\n") + "\n");
  zones.push({ key, heading: heading.replace(/^\d+[a-z]?\. /, ""), file, prose });
}
writeFileSync(join(out, "zones.json"), JSON.stringify(zones, null, 2) + "\n");
console.log(`${zones.length} diagrams: ${zones.map((z) => z.key).join(" ")}`);
