import fs from "node:fs/promises";
import path from "node:path";
import { parseSubtitles } from "@/lib/webcodecs/externalSubtitles";
import { languageCode } from "./languages";
import { displayTextOfFile } from "./text";

/**
 * Les sous-titres posés à côté du film (`Film (2001).fr.srt`) — la première source essayée, parce
 * qu'elle est gratuite : un petit fichier, lu d'un trait, sans toucher au film (DECISIONS.md §88).
 *
 * Le nom dit tout ce qu'on sait : la langue et les drapeaux suivent le nom du film, séparés par des
 * points — `.fr`, `.fre`, `.french`, `.VFQ`, `.forced`, `.sdh`, `.cc`, `.hi`. Un fichier sans langue
 * reconnue n'est pas indexé : le ranger sous une langue devinée mettrait des répliques anglaises
 * dans la recherche en français.
 */

export const SIDECAR_EXTENSIONS = [".srt", ".vtt", ".ass", ".ssa"] as const;

/** Un fichier de sous-titres plus gros que ça n'en est pas un. */
const MAX_SIDECAR_BYTES = 10 * 1024 * 1024;

export interface Sidecar {
  file: string;
  language: string;
  forced: boolean;
  hearingImpaired: boolean;
  size: number;
  mtimeMs: number;
}

export interface CueLine {
  startMs: number;
  endMs: number;
  text: string;
}

const FORCED = new Set(["forced", "force", "forces", "forcee", "forcees", "foreign"]);
const SDH = new Set(["sdh", "cc", "hi", "hoh", "malentendant", "malentendants"]);

/** Ce que le nom d'un fichier posé à côté de `videoFile` dit de lui — `null` s'il n'est pas à ce film. */
export function describeSidecarName(videoFile: string, candidate: string): Omit<Sidecar, "file" | "size" | "mtimeMs"> | null {
  const base = path.basename(videoFile, path.extname(videoFile));
  const name = path.basename(candidate);
  const ext = path.extname(name).toLowerCase();
  if (!(SIDECAR_EXTENSIONS as readonly string[]).includes(ext)) return null;
  if (!name.startsWith(base + ".")) return null;
  const tags = name
    .slice(base.length + 1, name.length - ext.length)
    .split(".")
    .map((t) => t.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""))
    .filter(Boolean);
  let language: string | null = null;
  let forced = false;
  let hearingImpaired = false;
  for (const tag of tags) {
    if (FORCED.has(tag)) forced = true;
    else if (SDH.has(tag)) hearingImpaired = true;
    else language ??= languageCode(tag);
  }
  return language ? { language, forced, hearingImpaired } : null;
}

/** Les sous-titres posés à côté d'un film, avec leur taille et leur date (la signature du film en dépend). */
export async function listSidecars(videoFile: string): Promise<Sidecar[]> {
  const dir = path.dirname(videoFile);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: Sidecar[] = [];
  for (const name of names.sort()) {
    const described = describeSidecarName(videoFile, name);
    if (!described) continue;
    const file = path.join(dir, name);
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SIDECAR_BYTES) continue;
      out.push({ ...described, file, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
    } catch {
      /* disparu entre la liste et la lecture */
    }
  }
  return out;
}

/**
 * Le meilleur fichier pour une langue : complet (jamais un forcé seul), ordinaire de préférence à SDH,
 * le plus gros à égalité — un sous-titre complet pèse bien plus qu'un fichier de panneaux traduits.
 */
export function bestSidecar(sidecars: readonly Sidecar[], language: string): Sidecar | null {
  const candidates = sidecars.filter((s) => s.language === language && !s.forced);
  candidates.sort((a, b) => Number(a.hearingImpaired) - Number(b.hearingImpaired) || b.size - a.size);
  return candidates[0] ?? null;
}

/** Décode les octets d'un fichier de sous-titres : UTF-8 (avec ou sans BOM), UTF-16, sinon Windows-1252. */
export function decodeSubtitleBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    // Les vieux .srt français sont souvent en Windows-1252 : lus en UTF-8, chaque accent devenait « � ».
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function assTime(value: string): number | null {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(value.trim());
  if (!m) return null;
  const fraction = m[4].padEnd(3, "0");
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(fraction);
}

/** Les lignes `Dialogue:` d'un fichier ASS/SSA, d'après sa ligne `Format:`. */
export function parseAssFile(text: string): CueLine[] {
  const out: CueLine[] = [];
  let inEvents = false;
  let fields: string[] = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
  for (const rawLine of text.replace(/\r/g, "").split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inEvents = line.toLowerCase() === "[events]";
      continue;
    }
    if (!inEvents) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const kind = line.slice(0, colon).trim().toLowerCase();
    const rest = line.slice(colon + 1);
    if (kind === "format") {
      fields = rest.split(",").map((f) => f.trim().toLowerCase());
      continue;
    }
    if (kind !== "dialogue") continue;
    const parts = rest.split(",");
    if (parts.length < fields.length) continue;
    const textAt = fields.indexOf("text");
    const value = (name: string) => parts[fields.indexOf(name)]?.trim() ?? "";
    const start = assTime(value("start"));
    const end = assTime(value("end"));
    if (start === null || end === null) continue;
    const body = displayTextOfFile(parts.slice(textAt).join(","), true);
    if (body) out.push({ startMs: start, endMs: Math.max(start, end), text: body });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Les répliques d'un fichier posé à côté, quel que soit son format. */
export function parseSidecarText(text: string, file: string): CueLine[] {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".ass" || ext === ".ssa") return parseAssFile(text);
  return parseSubtitles(text)
    .map((cue) => ({
      startMs: Math.round(cue.startSeconds * 1000),
      endMs: Math.round(cue.endSeconds * 1000),
      text: displayTextOfFile(cue.text),
    }))
    .filter((cue) => cue.text);
}

/** Lit un fichier posé à côté. `gate` : la même barrière que les lectures du film (pause, attente). */
export async function readSidecar(sidecar: Sidecar, gate?: (bytes: number) => Promise<void>): Promise<{ lines: CueLine[]; bytes: number }> {
  if (gate) await gate(sidecar.size);
  const bytes = new Uint8Array(await fs.readFile(sidecar.file));
  return { lines: parseSidecarText(decodeSubtitleBytes(bytes), sidecar.file), bytes: bytes.length };
}
