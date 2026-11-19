// Ce que les journaux disent des comptes pour le tri (DECISIONS.md §198) : quand chaque compte était
// actif et depuis quel type d'appareil (startup.log, auth.log, player.log), et quels titres chaque
// profil a ouverts (les lignes `start` de player.log). Lu en flux, ligne à ligne : player.log et ses
// archives font des dizaines de mégaoctets, et le serveur ne doit pas se figer le temps de les lire.
import fs from "node:fs";
import readline from "node:readline";
import { logGenerations } from "@/lib/logFile";
import { playerLogFiles } from "@/lib/playerLog";
import { AUTH_LOG, STARTUP_LOG } from "@/lib/eventLogs";
import { deviceOf } from "./score";

export interface DeviceEvent {
  user: string;
  at: number;
  device: string;
}

export interface OpenedItem {
  user: string;
  device: string;
  itemId: string;
  at: number;
  /** Le nom de la série pour un épisode (« Série — S01E02 · … »), sinon `null`. */
  seriesName: string | null;
}

/** Une séance du lecteur : sa ligne `start`, complétée par sa ligne `stop` quand elle existe. */
export interface LogSession {
  user: string;
  device: string;
  itemId: string;
  at: number;
  episode: string | null;
  watchedS: number | null;
  seriesName: string | null;
}

/** « Série — S04E03 · Titre » → { series: "Série", episode: "S04E03" }. */
export function episodeOfTitle(title: unknown): { series: string | null; episode: string | null } {
  if (typeof title !== "string") return { series: null, episode: null };
  const m = /^(.*?) — (S\d{1,2}E\d{1,3})\b/.exec(title);
  return m ? { series: m[1].trim(), episode: m[2] } : { series: null, episode: null };
}

async function eachLine(files: readonly string[], onLine: (line: string) => void): Promise<void> {
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) onLine(line);
  }
}

function parse(line: string): Record<string, unknown> | null {
  if (!line.includes('"user"')) return null;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface LogFacts {
  /** Toutes les traces d'activité, triées par instant. */
  events: DeviceEvent[];
  /** Un titre (élément Jellyfin) ouvert par un profil — la première fois seulement. */
  opened: OpenedItem[];
  /** Toutes les séances, une par `session` (la première ligne `start` de chacune). */
  sessions: LogSession[];
}

export async function readLogFacts(): Promise<LogFacts> {
  const events: DeviceEvent[] = [];
  const seen = new Set<string>();
  const opened: OpenedItem[] = [];
  const sessions = new Map<string, LogSession>();
  const pushEvent = (o: Record<string, unknown>) => {
    const user = typeof o.user === "string" ? o.user : null;
    const at = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    const device = deviceOf(typeof o.device === "string" ? o.device : undefined, typeof o.agent === "string" ? o.agent : undefined);
    if (!user || !device || !Number.isFinite(at)) return null;
    events.push({ user, at, device });
    return { user, at, device };
  };
  await eachLine([...logGenerations(STARTUP_LOG(), 3), ...logGenerations(AUTH_LOG(), 3)], (line) => {
    const o = parse(line);
    if (o) pushEvent(o);
  });
  await eachLine(playerLogFiles(), (line) => {
    const o = parse(line);
    if (!o) return;
    const e = pushEvent(o);
    if (!e || typeof o.itemId !== "string" || o.bench) return;
    const sid = typeof o.session === "string" ? o.session : null;
    if (o.kind === "stop" && sid) {
      const s = sessions.get(sid);
      // `watched` : les secondes réellement regardées de la séance (bilan du `stop`).
      const w = typeof o.watched === "number" ? o.watched : null;
      if (s && w !== null) s.watchedS = Math.max(s.watchedS ?? 0, w);
      return;
    }
    if (o.kind !== "start") return;
    const sessionKey = sid ?? `${e.user}|${o.itemId}|${Math.floor(e.at / 600_000)}`;
    if (!sessions.has(sessionKey)) {
      // « Série — S04E03 · Titre » : l'épisode se lit dans le titre de la ligne.
      const { series, episode } = episodeOfTitle(o.title);
      sessions.set(sessionKey, { user: e.user, device: e.device, itemId: o.itemId, at: e.at, episode, watchedS: null, seriesName: series });
    }
    const key = `${e.user}|${e.device}|${o.itemId}`;
    if (seen.has(key)) return;
    seen.add(key);
    opened.push({ user: e.user, device: e.device, itemId: o.itemId, at: e.at, seriesName: episodeOfTitle(o.title).series });
  });
  events.sort((a, b) => a.at - b.at);
  return { events, opened, sessions: [...sessions.values()] };
}

/**
 * Le type d'appareil d'un compte autour d'un instant : celui qui revient le plus dans la demi-heure
 * qui l'entoure. `null` quand le compte n'a rien laissé au journal à ce moment-là.
 */
export function deviceAround(events: readonly DeviceEvent[], user: string, at: number, windowMs = 30 * 60_000): string | null {
  // Recherche binaire du premier évènement dans la fenêtre.
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].at < at - windowMs) lo = mid + 1;
    else hi = mid;
  }
  const counts = new Map<string, number>();
  for (let i = lo; i < events.length && events[i].at <= at + windowMs; i++) {
    if (events[i].user === user) counts.set(events[i].device, (counts.get(events[i].device) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [d, c] of counts) if (c > n) [best, n] = [d, c];
  return best;
}
