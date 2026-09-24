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
import { AUTH_LOG, NOTIFICATIONS_LOG, EVENT_LOG_KEEP } from "@/lib/eventLogs";

export type LogSource = "player" | "server" | "auth" | "notifications" | "bench" | "benchPlayer";
export const LOG_SOURCES: LogSource[] = ["player", "server", "auth", "notifications", "bench", "benchPlayer"];

function generationsOf(source: LogSource): string[] {
  switch (source) {
    case "player":
      return logGenerations(playerLogFile(), PLAYER_LOG_KEEP);
    case "server":
      return logGenerations(SERVER_LOG_FILE, SERVER_LOG_KEEP);
    case "auth":
      return logGenerations(AUTH_LOG(), EVENT_LOG_KEEP);
    case "notifications":
      return logGenerations(NOTIFICATIONS_LOG(), EVENT_LOG_KEEP);
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
export const HEAVY_FIELDS: ReadonlySet<string> = new Set(["steps", "trace", "stack", "questions", "timeline"]);
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
  /**
   * L'identité du fichier sur le disque. Une rotation *renomme* : `player.log` devient `.1`, `.1`
   * devient `.2`. Sans elle, la nouvelle `.1`, souvent plus longue que l'ancienne (5 Mo plus une
   * ligne), passait pour « le même fichier, plus long » : on lisait sa fin à partir de l'ancien
   * point d'arrêt, et le cache gardait sous le nom `.1` les lignes de l'archive précédente — une
   * génération en double, la plus récente perdue, et des numéros de ligne qui menaient à d'autres
   * séances (relu le 24/09/2026). Un renommage garde l'inode ; un fichier neuf en a un autre.
   */
  ino: number;
  mtimeMs: number;
  size: number;
  /** Où la lecture s'est arrêtée — une ligne en cours d'écriture n'est pas prise. */
  consumed: number;
  lines: number;
  records: LogRecord[];
}
const cache = new Map<string, Cached>();

/**
 * Combien de générations restent en mémoire. Les journaux peuvent garder des centaines d'archives
 * (≈ 1 Go au total) ; en tenir le quart en objets dépasserait la mémoire du conteneur. Les plus
 * anciennement lues s'en vont — relire une archive coûte une lecture de 5 Mo, rien de plus.
 */
const MAX_CACHED_GENERATIONS = 12;

function remember(file: string, entry: Cached): void {
  // Réinsérée en fin : l'ordre d'insertion d'une Map sert d'ordre d'usage.
  cache.delete(file);
  cache.set(file, entry);
  while (cache.size > MAX_CACHED_GENERATIONS) cache.delete(cache.keys().next().value as string);
}

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
  if (known && known.ino === stat.ino && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
    remember(file, known);
    return known.records;
  }
  // Le même fichier, plus long : seulement la suite. Plus court (il a tourné) : tout.
  if (known && known.ino === stat.ino && stat.size > known.size && known.consumed <= stat.size) {
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
        remember(file, known);
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
  remember(file, { ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size, consumed, lines, records });
  return records;
}

/**
 * Les générations qui existent, **de la plus récente à la plus ancienne**, avec leur date de
 * dernière écriture. Une archive n'est plus jamais écrite après sa rotation : sa date dit donc
 * jusqu'où elle va, sans l'ouvrir.
 */
export function generationsNewestFirst(source: LogSource): { file: string; mtimeMs: number }[] {
  const out: { file: string; mtimeMs: number }[] = [];
  for (const file of [...generationsOf(source)].reverse()) {
    try {
      out.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      /* archive absente : le journal n'a pas encore tourné jusque-là */
    }
  }
  return out;
}

/** Les lignes d'une génération, lues (ou reprises du cache). */
export function readGenerationRecords(file: string): LogRecord[] {
  return readGeneration(file);
}

/**
 * Les lignes d'un journal depuis `since` (en ms), de la plus ancienne à la plus récente.
 *
 * On s'arrête à la première archive entièrement plus ancienne que `since` — sans l'ouvrir. La
 * génération qui chevauche la limite est lue en entier : la page filtre ensuite ce qu'elle veut.
 * Sans `since`, tout — à réserver à ce qui en a vraiment besoin.
 */
export function readRecords(source: LogSource, since = 0): LogRecord[] {
  const parts: LogRecord[][] = [];
  for (const { file, mtimeMs } of generationsNewestFirst(source)) {
    if (since && mtimeMs < since && parts.length > 0) break;
    parts.push(readGeneration(file));
  }
  return parts.reverse().flat();
}

/** Une ligne en entier, relue dans son fichier. `null` si le fichier a tourné entre-temps. */
/**
 * La ligne relue est-elle bien celle qu'on cherche ? Un numéro de ligne vaut pour un état du
 * fichier : entre la lecture et la relecture, une rotation a pu le décaler. `at` (l'instant lu la
 * première fois) départage — une ligne d'une autre séance n'est jamais rendue à sa place.
 */
function sameLine(parsed: Record<string, unknown>, at: number | undefined): boolean {
  if (at === undefined) return true;
  const stamp = typeof parsed.timestamp === "string" ? parsed.timestamp : typeof parsed.at === "string" ? parsed.at : null;
  return stamp !== null && Date.parse(stamp) === at;
}

export function readFullLine(source: LogSource, file: string, line: number, at?: number): Record<string, unknown> | null {
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
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return sameLine(parsed, at) ? parsed : null;
  } catch {
    return null;
  }
}

/** Plusieurs lignes d'un même fichier, en une lecture. */
export function readFullLines(source: LogSource, refs: { file: string; line: number; at?: number }[]): Record<string, unknown>[] {
  const byFile = new Map<string, { line: number; at?: number }[]>();
  for (const ref of refs) byFile.set(ref.file, [...(byFile.get(ref.file) ?? []), ref]);
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
    for (const { line, at } of wanted) {
      try {
        const parsed = JSON.parse(rows[line]) as Record<string, unknown>;
        if (sameLine(parsed, at)) out.push(parsed);
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
