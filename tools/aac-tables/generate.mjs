// Écrit src/lib/lumenServer/audio/aacTables.ts depuis libavcodec/aactab.c de FFmpeg (lancé par build.sh).
//
//   node generate.mjs <aactab.c> <sortie.ts>
//
// Les tables sont celles de la norme (ISO/IEC 14496-3, 4.A) telles que FFmpeg les écrit : les mots de
// code et longueurs des onze livres de Huffman spectraux et de celui des facteurs d'échelle, et les
// bornes des bandes de facteurs d'échelle (fenêtres longues et courtes) par indice de fréquence. Rien
// n'y est recopié à la main : un tableau mal recopié ne se verrait qu'en lisant mal un flux.
import { readFileSync, writeFileSync } from "node:fs";

const [, , source, out] = process.argv;
const c = readFileSync(source, "utf8");

/** Les valeurs d'un tableau C nommé `name` (`… name[…] = { … };`). */
function array(name) {
  const m = new RegExp(`\\b${name}\\s*\\[[^\\]]*\\]\\s*=\\s*\\{([^}]*)\\}`).exec(c);
  if (!m) throw new Error(`tableau ${name} introuvable`);
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s));
}

/** Les noms d'un tableau de pointeurs (`ff_swb_offset_1024[] = { swb_offset_1024_96, … }`). */
function pointers(name) {
  const m = new RegExp(`\\b${name}\\s*\\[\\]\\s*=\\s*\\{([^}]*)\\}`).exec(c);
  if (!m) throw new Error(`tableau ${name} introuvable`);
  return m[1]
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const books = [];
for (let i = 1; i <= 11; i++) {
  const codes = array(`codes${i}`);
  const bits = array(`bits${i}`);
  if (codes.length !== bits.length) throw new Error(`livre ${i} : ${codes.length} mots, ${bits.length} longueurs`);
  books.push({ codes, bits });
}
const sfCodes = array("ff_aac_scalefactor_code");
const sfBits = array("ff_aac_scalefactor_bits");
if (sfCodes.length !== 121 || sfBits.length !== 121) throw new Error("livre des facteurs d'échelle incomplet");

const long = pointers("ff_swb_offset_1024").map((n) => array(n));
const short = pointers("ff_swb_offset_128").map((n) => array(n));
const numLong = array("ff_aac_num_swb_1024");
const numShort = array("ff_aac_num_swb_128");
for (let i = 0; i < 13; i++) {
  if (long[i].length !== numLong[i] + 1 || long[i][numLong[i]] !== 1024) throw new Error(`bandes longues ${i} incohérentes`);
  if (short[i].length !== numShort[i] + 1 || short[i][numShort[i]] !== 128) throw new Error(`bandes courtes ${i} incohérentes`);
}

const row = (values) => `[${values.join(", ")}]`;
const lines = [
  "// FICHIER ÉCRIT PAR tools/aac-tables/build.sh — ne pas modifier à la main.",
  "//",
  "// Les tables de l'AAC (ISO/IEC 14496-3, 4.A) telles que FFmpeg 7.1.5 les écrit (libavcodec/aactab.c,",
  "// archive vérifiée par SHA-256, la version épinglée par tools/aac-wasm et tools/truehd-wasm). Lues par",
  "// `aacStream.ts` pour parcourir un raw_data_block jusqu'à ses éléments FIL — rien n'y est décodé.",
  "",
  "/** Les onze livres de Huffman spectraux, dans l'ordre (livre n à l'indice n − 1) : mots de code et longueurs. */",
  "export const AAC_SPECTRAL_BOOKS: readonly { codes: readonly number[]; bits: readonly number[] }[] = [",
  ...books.map((b) => `  { codes: ${row(b.codes)}, bits: ${row(b.bits)} },`),
  "];",
  "",
  "/** Le livre des facteurs d'échelle (et des positions d'intensité, des énergies de bruit) : 121 mots, indice − 60 = écart. */",
  `export const AAC_SCALEFACTOR_CODES: readonly number[] = ${row(sfCodes)};`,
  `export const AAC_SCALEFACTOR_BITS: readonly number[] = ${row(sfBits)};`,
  "",
  "/** Les bornes des bandes de facteurs d'échelle d'une fenêtre longue (1024), par indice de fréquence (0 à 12). */",
  "export const AAC_SWB_OFFSETS_LONG: readonly (readonly number[])[] = [",
  ...long.map((t) => `  ${row(t)},`),
  "];",
  "",
  "/** Les mêmes pour une fenêtre courte (128). */",
  "export const AAC_SWB_OFFSETS_SHORT: readonly (readonly number[])[] = [",
  ...short.map((t) => `  ${row(t)},`),
  "];",
  "",
];
writeFileSync(out, lines.join("\n"));
console.log(`${out} : ${books.reduce((s, b) => s + b.codes.length, 0)} mots spectraux, 121 facteurs d'échelle, 13 + 13 tables de bandes`);
