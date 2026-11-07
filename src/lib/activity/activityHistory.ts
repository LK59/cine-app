import { getDb } from "@/lib/db";
import { readRecords } from "@/lib/activity/logReader";
import { buildSeances, type Seance } from "@/lib/activity/seances";
import type { LogRecord } from "@/lib/activity/logReader";
import { acknowledgeSeances } from "@/lib/activity/alertsCleared";
import { addTally, emptyTally, localDay, signalsOf, tallySignals, type SignalTally, type WeekSignals } from "@/lib/activity/accounts";

/**
 * L'Activité « depuis le début » (20/10/2026) : le compte de chaque jour, gardé en base une fois le
 * jour clos, et seuls les derniers jours relus dans les journaux.
 *
 * Pourquoi pas tout relire : les journaux du lecteur gardent jusqu'à 120 archives de 5 Mo — des
 * années —, et la semaine se relit déjà toutes les vingt secondes page ouverte. Trente jours se
 * calculent en ~50 ms ; un an d'archives tiendrait le serveur plusieurs secondes et des centaines de
 * Mo de lignes en mémoire. Le compte d'un jour, lui, fait quelques centaines d'octets. Et il survit à
 * la rotation : un jour sorti des archives reste compté.
 *
 * Un jour est figé trois jours après sa fin : un arrêt qu'iOS a empêché de partir n'arrive qu'au
 * lancement suivant (`why: "lost"`, `unsentStop.ts`), et le temps regardé de la séance est dans
 * cette ligne-là. Ce qui arrive plus tard encore n'est pas recompté — c'est rare, et le dire vaut
 * mieux que relire des mois de journaux à chaque appel.
 *
 * Depuis le 07/11/2026, il suit « Effacer les alertes » comme les autres périodes : un jour clos avant
 * l'effacement garde ses séances et son temps regardé, sans ses incidents (`withoutIncidents`) — les
 * erreurs des anciennes versions ne pèsent plus sur l'historique. Les comptes gardés ne changent pas.
 */

const DAY = 24 * 60 * 60 * 1000;
/** Les jours plus récents que ça se relisent dans les journaux à chaque appel. */
export const LIVE_DAYS = 3;
/**
 * La forme du compte gardé. Un changement de ce que compte `tallySignals` la fait monter : les jours
 * gardés sous l'ancienne sont oubliés et recomptés depuis ce que les journaux ont encore.
 */
// 2 (07/11/2026) : le temps par compte (`byUser`). Les journaux remontaient alors jusqu'au premier jour
// gardé (04/09/2026) : le recompte n'a rien perdu.
export const TALLY_VERSION = 2;
/** Au-delà de six mois, une barre par mois plutôt que par semaine. */
const MAX_WEEK_BARS = 26;

interface Row {
  day: string;
  tally: string;
}

/** Minuit local du jour `day` (« 2026-10-20 »). */
function dayStart(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** Minuit local du jour qui suit celui qui commence à `start`. */
function nextDay(start: number): number {
  const d = new Date(start);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

function startOfLocalDay(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function parseTally(raw: string): SignalTally | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SignalTally>;
    return { ...emptyTally(), ...parsed };
  } catch {
    return null;
  }
}

/** Les comptes de chaque jour entre `from` (inclus) et `to` (exclu), jours vides compris. */
function tallyDays(seances: readonly Seance[], server: readonly LogRecord[], from: number, to: number, clearedAt = 0): Map<string, SignalTally> {
  const byDay = new Map<string, { seances: Seance[]; server: LogRecord[] }>();
  for (let d = from; d < to; d = nextDay(d)) byDay.set(localDay(new Date(d)), { seances: [], server: [] });
  for (const s of seances) {
    if (s.start >= from && s.start < to) byDay.get(localDay(new Date(s.start)))?.seances.push(s);
  }
  for (const r of server) {
    if (r._t >= from && r._t < to) byDay.get(localDay(new Date(r._t)))?.server.push(r);
  }
  return new Map([...byDay].map(([day, v]) => [day, tallySignals(acknowledgeSeances(v.seances, clearedAt), v.server, clearedAt)]));
}

/**
 * Compte et garde les jours clos qui manquent : la première fois, tout ce que les journaux ont ;
 * ensuite, seulement les jours venus depuis le dernier gardé.
 */
function freezeClosedDays(frozenEnd: number, now: number): void {
  const db = getDb();
  db.prepare("DELETE FROM activity_day_tallies WHERE version <> ?").run(TALLY_VERSION);
  const last = (db.prepare("SELECT MAX(day) AS day FROM activity_day_tallies").get() as { day: string | null }).day;
  const from = last ? nextDay(dayStart(last)) : 0;
  if (from >= frozenEnd) return;
  // Un jour de marge avant : une séance commencée la veille au soir se lit depuis sa première ligne,
  // et ne compte pas, à tort, pour le lendemain.
  const since = from ? from - DAY : 0;
  const seances = buildSeances(readRecords("player", since)).filter((s) => s.start >= from);
  const server = readRecords("server", since).filter((r) => r._t >= from);
  // Une boucle et non `Math.min(...)` : des dizaines de milliers de lignes dépasseraient la pile.
  let first = frozenEnd;
  for (const s of seances) if (s.start < first) first = s.start;
  for (const r of server) if (r._t < first) first = r._t;
  const start = from || startOfLocalDay(first);
  const days = tallyDays(seances, server, start, frozenEnd);
  const insert = db.prepare("INSERT OR REPLACE INTO activity_day_tallies (day, version, tally, computed_at) VALUES (?, ?, ?, ?)");
  db.transaction(() => {
    for (const [day, tally] of days) insert.run(day, TALLY_VERSION, JSON.stringify(tally), now);
  })();
}

/** Les barres de tout l'historique : par semaine (du lundi), par mois au-delà de six mois. */
function historyBars(days: [string, SignalTally][]): { perDay: WeekSignals["perDay"]; bucket: "week" | "month" } {
  const weekOf = (day: string) => {
    const d = new Date(dayStart(day));
    return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)));
  };
  const group = (keyOf: (day: string) => string) => {
    const bars = new Map<string, { day: string; seances: number; problems: number }>();
    for (const [day, t] of days) {
      const key = keyOf(day);
      const bar = bars.get(key) ?? { day: key, seances: 0, problems: 0 };
      bar.seances += t.seances;
      bar.problems += t.problems;
      bars.set(key, bar);
    }
    return [...bars.values()];
  };
  const weeks = group(weekOf);
  if (weeks.length <= MAX_WEEK_BARS) return { perDay: weeks, bucket: "week" };
  return { perDay: group((day) => `${day.slice(0, 7)}-01`), bucket: "month" };
}

/** Le compte d'un jour sans ses incidents : ce qui reste quand les alertes d'avant ont été effacées. */
function withoutIncidents(t: SignalTally): SignalTally {
  return {
    ...emptyTally(),
    seances: t.seances,
    viewers: t.viewers,
    watchedSeconds: t.watchedSeconds,
    seeks: t.seeks,
    audioSwitches: t.audioSwitches,
    lost: t.lost,
    staleReloads: t.staleReloads,
    byUser: t.byUser,
  };
}

/**
 * Le compte de chaque jour depuis la première séance, du plus ancien au plus récent : les jours clos
 * gardés en base, les derniers relus dans les journaux. Sans les incidents d'avant l'effacement.
 */
function allDays(now: number, clearedAt: number): [string, SignalTally][] {
  const today = new Date(now);
  const frozenEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() - LIVE_DAYS).getTime();
  freezeClosedDays(frozenEnd, now);

  const stored = (getDb().prepare("SELECT day, tally FROM activity_day_tallies ORDER BY day").all() as Row[])
    .map((r) => [r.day, parseTally(r.tally)] as const)
    .filter((e): e is readonly [string, SignalTally] => e[1] !== null)
    .map(([day, t]) => [day, clearedAt && nextDay(dayStart(day)) <= clearedAt ? withoutIncidents(t) : t] as const);
  const seances = buildSeances(readRecords("player", frozenEnd - DAY)).filter((s) => s.start >= frozenEnd);
  const server = readRecords("server", frozenEnd).filter((r) => r._t >= frozenEnd);
  const live = tallyDays(seances, server, frozenEnd, nextDay(startOfLocalDay(now)), clearedAt);

  // Les jours vides d'avant la première séance ne font pas commencer l'historique plus tôt.
  const all: [string, SignalTally][] = [...stored.map(([d, t]) => [d, t] as [string, SignalTally]), ...live];
  const firstUsed = all.findIndex(([, t]) => t.seances > 0);
  return firstUsed < 0 ? all.slice(-1) : all.slice(firstUsed);
}

/** Le bilan depuis la première ligne des journaux. */
export function allTimeSignals(now = Date.now(), clearedAt = 0): WeekSignals {
  const days = allDays(now, clearedAt);
  const total = days.reduce((acc, [, t]) => addTally(acc, t), emptyTally());
  const since = days.length ? dayStart(days[0][0]) : startOfLocalDay(now);
  const { perDay, bucket } = historyBars(days);
  return signalsOf(total, since, perDay, bucket);
}

/**
 * Trente jours de la courbe des heures regardées, finissant le jour `end` (« 2026-10-07 ») — pour
 * remonter tout l'historique depuis le tableau de bord (07/11/2026). `first` : le premier jour qui a
 * une séance, où les flèches s'arrêtent.
 */
export function historySeries(end: string, now = Date.now(), clearedAt = 0, span = 30): { first: string | null; series: { day: string; seances: number; watchedSeconds: number; real: number }[] } {
  const days = allDays(now, clearedAt);
  const byDay = new Map(days);
  const endStart = dayStart(end);
  const series: { day: string; seances: number; watchedSeconds: number; real: number }[] = [];
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date(endStart);
    const day = localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i));
    const t = byDay.get(day);
    series.push({ day, seances: t?.seances ?? 0, watchedSeconds: t?.watchedSeconds ?? 0, real: t?.problems ?? 0 });
  }
  return { first: days.find(([, t]) => t.seances > 0)?.[0] ?? null, series };
}
