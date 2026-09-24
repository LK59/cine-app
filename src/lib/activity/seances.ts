// Les lignes du journal du lecteur, regroupées en séances : une ouverture de titre, ce qui s'y est
// passé, et son bilan.
//
// Depuis le 23/09/2026, chaque ligne porte l'identifiant de sa séance (`session`) et la séance se
// termine par une ligne `stop` qui en fait le bilan. Avant, rien ne reliait les lignes : une
// séance est alors reconstituée par compte et par titre, ouverte par un `start` qui n'est pas une
// reconstruction.

import { deviceLabel } from "@/lib/deviceLabel";
import type { LogRecord } from "@/lib/activity/logReader";

export interface Seance {
  id: string;
  /** Vrai pour une séance reconstituée (avant le 23/09/2026) : pas de bilan, des comptes partiels. */
  legacy: boolean;
  user: string;
  itemId: string | null;
  title: string;
  start: number;
  end: number;
  device: string | null;
  /** Le temps d'ouverture de la première ouverture (hors reconstructions), en ms. */
  openedMs: number | null;
  /** « natif » (remultiplexage ou canevas) ou « serveur ». */
  player: "natif" | "serveur";
  path: string | null;
  video: string | null;
  range: string | null;
  container: string | null;
  /** Le bilan, quand il est arrivé. */
  stop: {
    why: string | null;
    watched: number | null;
    at: number | null;
    ended: boolean;
    waits: number;
    waitedMs: number;
    longestWaitMs: number;
    seekWaitMs: number;
    backgrounds: number;
    backgroundMs: number;
    lateByMs: number | null;
  } | null;
  seeks: number;
  slowSeeks: number;
  audioSwitches: number;
  /** Les reconstructions qui sont des incidents : réseau, décodeur, tampon refusé. */
  rebuilds: number;
  /**
   * Les reconstructions au retour d'arrière-plan (ligne `rebuild` portant `hiddenMs`) : iOS a fermé
   * la source pendant que l'application était cachée, et le lecteur la rouvre. Rien n'a échoué ;
   * les compter comme des incidents faisait passer pour fragile un appareil qu'on avait juste
   * rangé dans sa poche (24/09/2026).
   */
  backgroundRebuilds: number;
  stalls: number;
  fallbacks: number;
  errors: number;
  /** Les motifs des incidents, dans l'ordre — de quoi dire « pourquoi » sans ouvrir la séance. */
  incidents: { kind: string; t: number; reason: string }[];
}

/** Un saut qui prend plus que ça se remarque : c'est le seuil du banc d'essai. */
export const SLOW_SEEK_MS = 3000;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function blank(id: string, legacy: boolean, r: LogRecord): Seance {
  return {
    id,
    legacy,
    user: str(r.user) ?? "?",
    itemId: str(r.itemId),
    title: str(r.title) ?? "?",
    start: r._t,
    end: r._t,
    device: deviceLabel(str(r.agent)),
    openedMs: null,
    player: r.player === "serveur" ? "serveur" : "natif",
    path: str(r.path),
    video: str(r.video),
    range: str(r.range),
    container: str(r.container),
    stop: null,
    seeks: 0,
    slowSeeks: 0,
    audioSwitches: 0,
    rebuilds: 0,
    backgroundRebuilds: 0,
    stalls: 0,
    fallbacks: 0,
    errors: 0,
    incidents: [],
  };
}

function absorb(s: Seance, r: LogRecord): void {
  s.end = Math.max(s.end, r._t);
  s.start = Math.min(s.start, r._t);
  s.device ??= deviceLabel(str(r.agent));
  if (r.player === "serveur") s.player = "serveur";
  const reason = str(r.reason) ?? str(r.message) ?? str(r.why) ?? "";
  switch (r.kind) {
    case "start":
      if (s.openedMs === null && !(num(r.rebuild) ?? 0)) s.openedMs = num(r.openedInMs);
      s.path = str(r.path) ?? s.path;
      s.video ??= str(r.video);
      s.range ??= str(r.range);
      s.container ??= str(r.container);
      if (s.title === "?") s.title = str(r.title) ?? "?";
      break;
    case "seek": {
      s.seeks += 1;
      const took = num(r.tookMs);
      // Au-delà d'une minute, c'est un saut qui a traversé un passage en arrière-plan (mesure
      // d'avant le 24/09/2026), pas une attente.
      if (took !== null && took > SLOW_SEEK_MS && took < 60_000) s.slowSeeks += 1;
      break;
    }
    case "audio":
      s.audioSwitches += 1;
      break;
    case "rebuild":
      if (num(r.hiddenMs) !== null) {
        s.backgroundRebuilds += 1;
        break;
      }
      s.rebuilds += 1;
      s.incidents.push({ kind: "rebuild", t: r._t, reason });
      break;
    case "stall":
      s.stalls += 1;
      s.incidents.push({ kind: "stall", t: r._t, reason: `${num(r.position)?.toFixed(0) ?? "?"} s` });
      break;
    case "fallback":
      s.fallbacks += 1;
      s.incidents.push({ kind: "fallback", t: r._t, reason });
      break;
    case "error":
      s.errors += 1;
      s.incidents.push({ kind: "error", t: r._t, reason });
      break;
    case "stop":
      // La dernière ligne de bilan l'emporte : une séance perdue par iOS est renvoyée au lancement
      // suivant (`why: "lost"`), après la ligne qu'elle remplace.
      s.stop = {
        why: str(r.why),
        watched: num(r.watched),
        at: num(r.at),
        ended: r.ended === true,
        waits: num(r.waits) ?? 0,
        waitedMs: num(r.waitedMs) ?? 0,
        longestWaitMs: num(r.longestWaitMs) ?? 0,
        seekWaitMs: num(r.seekWaitMs) ?? 0,
        backgrounds: num(r.backgrounds) ?? 0,
        backgroundMs: num(r.backgroundMs) ?? 0,
        lateByMs: num(r.lateByMs),
      };
      break;
  }
}

/** Les séances d'un journal du lecteur, les plus récentes d'abord. */
export function buildSeances(records: LogRecord[]): Seance[] {
  const byId = new Map<string, Seance>();
  /** Séance reconstituée en cours, par compte et par titre. */
  const legacyOpen = new Map<string, Seance>();
  for (const r of records) {
    if (r.bench) continue;
    const session = str(r.session);
    if (session) {
      let s = byId.get(session);
      if (!s) byId.set(session, (s = blank(session, false, r)));
      absorb(s, r);
      continue;
    }
    const key = `${str(r.user) ?? "?"}|${str(r.itemId) ?? str(r.title) ?? "?"}`;
    let s = legacyOpen.get(key);
    const opens = r.kind === "start" && !(num(r.rebuild) ?? 0);
    if (!s || opens) {
      s = blank(`ancienne:${key}:${r._t}`, true, r);
      byId.set(s.id, s);
      legacyOpen.set(key, s);
    }
    absorb(s, r);
  }
  return [...byId.values()].sort((a, b) => b.start - a.start);
}
