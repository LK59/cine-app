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
  /** « natif » (remultiplexage — ou canevas, dans les séances d'avant le 24/09/2026) ou « serveur ». */
  player: "natif" | "serveur";
  path: string | null;
  video: string | null;
  range: string | null;
  container: string | null;
  /**
   * Le temps regardé sur toute la séance, en secondes — null quand aucune ligne n'en dit rien.
   *
   * La somme de ce que chaque lecteur a joué : le lecteur natif le dit sur son `fallback` quand il
   * passe la main (sa ligne `stop` ne partira pas), le lecteur serveur sur sa fin de diffusion et
   * sur son `stop`, chacun pour sa part seulement. Depuis le 25/09/2026, le lecteur serveur
   * poursuit la séance du lecteur natif au lieu d'en ouvrir une : un repli se lisait en deux
   * séances, dont celle qui avait joué à zéro seconde regardée (24/09/2026). Les lignes d'avant
   * n'ont pas ces champs, et se lisent comme avant.
   */
  watched: number | null;
  /** Le bilan, quand il est arrivé. `stop.watched` y est la somme de la séance, comme `watched`. */
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
  /** Les replis qui échouent. Une diffusion vers la télévision (AirPlay) n'en est pas un. */
  fallbacks: number;
  /**
   * Les passages au lecteur serveur pour diffuser — « diffusion demandée ». Comptés à part : ils
   * faisaient accuser un appareil dans le diagnostic « fichier ou appareil », sept envois vers la
   * télé tenant lieu de sept échecs (relu le 24/09/2026).
   */
  casts: number;
  /**
   * Un téléviseur a réellement pris la lecture (ligne `cast`, « diffusion établie ») — et non
   * seulement demandée. Une séance rouverte sur le téléphone puis envoyée à la télé par les
   * commandes de la vidéo n'a pas de repli « diffusion demandée » : sans ceci, elle se lisait
   * comme une lecture serveur sur téléphone (24/09/2026).
   */
  onTv: boolean;
  errors: number;
  /** Les motifs des incidents, dans l'ordre — de quoi dire « pourquoi » sans ouvrir la séance. */
  incidents: { kind: string; t: number; reason: string }[];
}

/** Un saut qui prend plus que ça se remarque : c'est le seuil du banc d'essai. */
export const SLOW_SEEK_MS = 3000;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Un repli qui est une diffusion : le champ posé depuis le 24/09/2026, ou, avant, la phrase. */
function isCast(r: LogRecord, reason: string): boolean {
  const takeover = r.takeover as { cast?: unknown } | undefined;
  // « fin de diffusion » : la ligne l'écrivait sans champ `cast` avant le 24/09/2026, et chaque
  // diffusion terminée comptait comme un repli raté.
  return (
    r.cast === true ||
    r["takeover.cast"] === true ||
    takeover?.cast === true ||
    reason === "diffusion demandée" ||
    reason.startsWith("fin de diffusion")
  );
}

function blank(id: string, legacy: boolean, r: LogRecord): Seance {
  return {
    id,
    legacy,
    user: str(r.user) ?? "?",
    itemId: str(r.itemId),
    title: str(r.title) ?? "?",
    start: lineTime(r),
    end: lineTime(r),
    device: deviceLabel(str(r.agent)),
    openedMs: null,
    player: r.player === "serveur" ? "serveur" : "natif",
    path: str(r.path),
    video: str(r.video),
    range: str(r.range),
    container: str(r.container),
    watched: null,
    stop: null,
    seeks: 0,
    slowSeeks: 0,
    audioSwitches: 0,
    rebuilds: 0,
    backgroundRebuilds: 0,
    stalls: 0,
    fallbacks: 0,
    casts: 0,
    onTv: false,
    errors: 0,
    incidents: [],
  };
}

/**
 * L'instant qu'une ligne décrit. Un bilan perdu (`why: "lost"`) arrive au lancement suivant, parfois
 * une heure après ; il porte `lateByMs`, l'écart entre sa mesure et son envoi. Daté de son arrivée,
 * il étirait dix minutes de film sur une heure dans la frise (relu le 24/09/2026).
 */
export function lineTime(r: { _t: number; kind?: unknown; lateByMs?: unknown }): number {
  const late = r.kind === "stop" ? num(r.lateByMs) : null;
  return late !== null && late > 0 ? r._t - late : r._t;
}

function absorb(s: Seance, r: LogRecord): void {
  const t = lineTime(r);
  s.end = Math.max(s.end, t);
  s.start = Math.min(s.start, t);
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
      // La part du lecteur qui passe la main — voir `watched`.
      addWatched(s, num(r.watched));
      if (isCast(r, reason)) {
        s.casts += 1;
        break;
      }
      s.fallbacks += 1;
      s.incidents.push({ kind: "fallback", t: r._t, reason });
      break;
    case "cast":
      s.onTv = true;
      break;
    case "error":
      s.errors += 1;
      s.incidents.push({ kind: "error", t: r._t, reason });
      break;
    case "stop":
      // La dernière ligne de bilan l'emporte : une séance perdue par iOS est renvoyée au lancement
      // suivant (`why: "lost"`), après la ligne qu'elle remplace. Son `watched` n'est que la part
      // du dernier lecteur : la somme se fait à la fin (`finish`), pour qu'un bilan remplacé ne
      // compte pas deux fois.
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

/** Le temps joué avant un relais, cumulé à part jusqu'à `finish`. */
const handedWatched = new WeakMap<Seance, number>();

function addWatched(s: Seance, seconds: number | null): void {
  if (seconds === null || seconds < 0) return;
  handedWatched.set(s, (handedWatched.get(s) ?? 0) + seconds);
}

/** Le temps regardé de la séance : les parts des relais, plus celle du dernier bilan. */
function finish(s: Seance): Seance {
  const handed = handedWatched.get(s) ?? null;
  const own = s.stop?.watched ?? null;
  s.watched = handed === null && own === null ? null : (handed ?? 0) + (own ?? 0);
  if (s.stop) s.stop.watched = s.watched;
  return s;
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
    // Une relance (`retry`, lecteur serveur) n'ouvre pas une séance, pas plus qu'une reconstruction.
    const opens = r.kind === "start" && !(num(r.rebuild) ?? 0) && !(num(r.retry) ?? 0);
    if (!s || opens) {
      s = blank(`ancienne:${key}:${r._t}`, true, r);
      byId.set(s.id, s);
      legacyOpen.set(key, s);
    }
    absorb(s, r);
  }
  return [...byId.values()].map(finish).sort((a, b) => b.start - a.start);
}
