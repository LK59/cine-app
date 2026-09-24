// Les journaux, relus pour la page d'activité de l'administrateur.
//
// Quatre fichiers d'une ligne JSON chacun, tournés à 5 Mo avec leurs archives (`logFile.ts`) :
// jusqu'à trente mégaoctets pour le seul journal du lecteur. Les relire en entier à chaque
// affichage tiendrait la boucle d'événements plusieurs centaines de millisecondes — le serveur
// entier attendrait. Donc :
//  - chaque génération est lue une fois et gardée sous une forme **compacte** (les champs lourds —
//    traces, piles — retirés, les chaînes longues coupées) ; une archive ne change plus ;
//  - le fichier courant, qui grandit pendant qu'on regarde, n'est relu qu'à partir de l'octet où
//    on s'était arrêté ;
//  - la ligne complète est relue à la demande (`readFullLine`), par son fichier et son rang.

import fs from "node:fs";
import path from "node:path";
import { logGenerations } from "@/lib/logFile";
import { playerLogFile, benchPlayerLogFile, PLAYER_LOG_KEEP, BENCH_PLAYER_LOG_KEEP } from "@/lib/playerLog";
import { SERVER_LOG_FILE, SERVER_LOG_KEEP } from "@/lib/logger";
import { BENCH_LOG, BENCH_LOG_KEEP } from "@/lib/playerBench/benchLog";

export type LogSource = "player" | "server" | "bench" | "benchPlayer";
export const LOG_SOURCES: LogSource[] = ["player", "server", "bench", "benchPlayer"];

function generationsOf(source: LogSource): string[] {
  switch (source) {
    case "player":
      return logGenerations(playerLogFile(), PLAYER_LOG_KEEP);
    case "server":
      return logGenerations(SERVER_LOG_FILE, SERVER_LOG_KEEP);
    case "bench":
      return logGenerations(BENCH_LOG(), BENCH_LOG_KEEP);
    case "benchPlayer":
      return logGenerations(benchPlayerLogFile(), BENCH_PLAYER_LOG_KEEP);
  }
}

/** Une ligne telle que la page s'en sert : ses champs courts, et d'où la relire en entier. */
export type LogRecord = Record<string, unknown> & {
  /** Le fichier (nom seul) et le rang de la ligne dans ce fichier, pour `readFullLine`. */
  _file: string;
  _line: number;
  /** L'instant, en millisecondes — `timestamp` ou `at`, selon le journal. */
  _t: number;
};

/** Ce qui ne sert qu'au détail d'une ligne, et pèse l'essentiel de son poids. */
const HEAVY_FIELDS = new Set(["steps", "trace", "stack", "questions", "timeline"]);
const MAX_STRING = 240;

function compact(entry: Record<string, unknown>, file: string, line: number): LogRecord {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (HEAVY_FIELDS.has(key)) {
      out[key] = true;
      continue;
    }
    out[key] = typeof value === "string" && value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  const stamp = typeof entry.timestamp === "string" ? entry.timestamp : typeof entry.at === "string" ? entry.at : null;
  return { ...out, _file: file, _line: line, _t: stamp ? Date.parse(stamp) || 0 : 0 };
}

interface Cached {
  mtimeMs: number;
  size: number;
  /** Où la lecture s'est arrêtée — une ligne en cours d'écriture n'est pas prise. */
  consumed: number;
  lines: number;
  records: LogRecord[];
}
const cache = new Map<string, Cached>();

function parseChunk(text: string, file: string, firstLine: number, into: LogRecord[]): { lines: number; consumed: number } {
  // La dernière ligne sans retour est peut-être à moitié écrite : elle attend la prochaine lecture.
  const end = text.lastIndexOf("\n");
  if (end < 0) return { lines: 0, consumed: 0 };
  const body = text.slice(0, end);
  let n = 0;
  for (const raw of body.split("\n")) {
    const lineNo = firstLine + n;
    n += 1;
    if (!raw) continue;
    try {
      into.push(compact(JSON.parse(raw) as Record<string, unknown>, file, lineNo));
    } catch {
      /* une ligne tronquée par une rotation */
    }
  }
  return { lines: n, consumed: Buffer.byteLength(body, "utf8") + 1 };
}

function readGeneration(file: string): LogRecord[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    cache.delete(file);
    return [];
  }
  const name = path.basename(file);
  const known = cache.get(file);
  if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return known.records;
  // Le même fichier, plus long : seulement la suite. Plus court (il a tourné) : tout.
  if (known && stat.size > known.size && known.consumed <= stat.size) {
    try {
      const fd = fs.openSync(file, "r");
      try {
        const buffer = Buffer.alloc(stat.size - known.consumed);
        fs.readSync(fd, buffer, 0, buffer.length, known.consumed);
        const { lines, consumed } = parseChunk(buffer.toString("utf8"), name, known.lines, known.records);
        known.lines += lines;
        known.consumed += consumed;
        known.mtimeMs = stat.mtimeMs;
        known.size = stat.size;
        return known.records;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* relu en entier ci-dessous */
    }
  }
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const records: LogRecord[] = [];
  const { lines, consumed } = parseChunk(text, name, 0, records);
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, consumed, lines, records });
  return records;
}

/** Toutes les lignes d'un journal, archives comprises, de la plus ancienne à la plus récente. */
export function readRecords(source: LogSource): LogRecord[] {
  return generationsOf(source).flatMap(readGeneration);
}

/** Une ligne en entier, relue dans son fichier. `null` si le fichier a tourné entre-temps. */
export function readFullLine(source: LogSource, file: string, line: number): Record<string, unknown> | null {
  const target = generationsOf(source).find((f) => path.basename(f) === file);
  if (!target) return null;
  let text = "";
  try {
    text = fs.readFileSync(target, "utf8");
  } catch {
    return null;
  }
  const raw = text.split("\n")[line];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Plusieurs lignes d'un même fichier, en une lecture. */
export function readFullLines(source: LogSource, refs: { file: string; line: number }[]): Record<string, unknown>[] {
  const byFile = new Map<string, number[]>();
  for (const ref of refs) byFile.set(ref.file, [...(byFile.get(ref.file) ?? []), ref.line]);
  const out: Record<string, unknown>[] = [];
  for (const target of generationsOf(source)) {
    const wanted = byFile.get(path.basename(target));
    if (!wanted) continue;
    let rows: string[] = [];
    try {
      rows = fs.readFileSync(target, "utf8").split("\n");
    } catch {
      continue;
    }
    for (const n of wanted) {
      try {
        out.push(JSON.parse(rows[n]) as Record<string, unknown>);
      } catch {
        /* déplacée par une rotation */
      }
    }
  }
  return out;
}

/** Le type d'une ligne, quel que soit le journal : `kind` (lecteur, banc) ou `scope` (serveur). */
export function typeOf(r: Record<string, unknown>): string {
  return String(r.kind ?? r.scope ?? r.level ?? "?");
}

export const __testing = { reset: () => cache.clear() };
