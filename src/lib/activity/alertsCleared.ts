import { readOverride, writeOverride } from "@/lib/settings/store";
import type { Seance } from "@/lib/activity/seances";

/**
 * Les alertes du panneau Activités que l'administrateur a effacées (09/10/2026, DECISIONS.md §59).
 *
 * Demandé pour « clear les incidents, blocages, jetons refusés — toutes les alertes rouges, orange
 * et jaunes ». Effacer n'efface rien des journaux : le diagnostic, les signalements et les vues
 * brutes (journaux, détail d'une séance) en dépendent. C'est une date, la même pour tout le
 * panneau : ce qui colore une tuile, une pastille ou une barre ne se compte plus qu'*après* elle, et
 * un nouvel incident se voit de nouveau aussitôt. Une seule date et non une par compte : « tout est
 * vu » est un seul geste, et une date par compte aurait laissé les tuiles de la semaine, qui
 * mêlent tous les comptes, sans règle claire.
 *
 * Rangée avec les clés internes des réglages (`__…`), comme `diagnosisCleared.ts`.
 */
const KEY = "__ACTIVITY_ALERTS_CLEARED";

/** La date d'effacement, ou 0 : rien n'a été effacé (ou tout a été réaffiché). */
export function alertsClearedAt(): number {
  try {
    const value = Number(readOverride(KEY) ?? 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** Efface (une date), ou réaffiche tout (0). */
export function setAlertsClearedAt(at: number): void {
  writeOverride(KEY, String(Math.max(0, Math.floor(at))));
}

/**
 * Une séance terminée avant l'effacement, sans ses incidents : elle reste dans les listes et
 * s'ouvre comme avant (son détail relit le journal), mais ne colore plus rien — ni ses pastilles,
 * ni les tuiles de la semaine, ni la qualité de son appareil. Une séance encore en cours, ou finie
 * après, garde tout.
 */
export function acknowledgeSeance(s: Seance, clearedAt: number): Seance {
  if (!clearedAt || s.end > clearedAt) return s;
  return {
    ...s,
    stalls: 0,
    rebuilds: 0,
    fallbacks: 0,
    errors: 0,
    slowSeeks: 0,
    incidents: [],
    stop: s.stop ? { ...s.stop, waits: 0, waitedMs: 0, longestWaitMs: 0 } : null,
  };
}

export function acknowledgeSeances(list: Seance[], clearedAt: number): Seance[] {
  return clearedAt ? list.map((s) => acknowledgeSeance(s, clearedAt)) : list;
}

/** Une ligne de journal postérieure à l'effacement — les seules qui comptent pour une alerte. */
export function afterClear(clearedAt: number) {
  return (r: { _t: number }) => r._t > clearedAt;
}
