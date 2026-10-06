import { readOverride, writeOverride } from "@/lib/settings/store";

/**
 * Les titres du diagnostic « le fichier ou l'appareil ? » que l'administrateur a effacés
 * (demandé le 06/10/2026). Un titre n'en sortait qu'au bout de trente jours, ou chassé du
 * classement : Le Mans 66 et Dirty Dancing restaient affichés longtemps après qu'on s'en était
 * occupé.
 *
 * Effacer n'efface rien du journal : c'est une date par titre. Un titre réapparaît s'il échoue de
 * nouveau *après* elle — la panne réglée qui revient doit se voir. Rangé avec les clés internes
 * des réglages (`__…`), qui ne sont jamais montrées ni exportées.
 */
const KEY = "__DIAGNOSIS_CLEARED";
/** Au-delà, la date d'effacement ne sert plus : le diagnostic ne regarde que trente jours. */
const KEEP_MS = 31 * 24 * 3600_000;

export function clearedDiagnosis(): Record<string, number> {
  try {
    const parsed = JSON.parse(readOverride(KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function clearDiagnosis(keys: string[], now = Date.now()): void {
  const all = clearedDiagnosis();
  for (const k of keys) all[k] = now;
  for (const [k, at] of Object.entries(all)) if (now - at > KEEP_MS) delete all[k];
  writeOverride(KEY, JSON.stringify(all));
}

/** Les titres encore à montrer : jamais effacés, ou en échec depuis. */
export function withoutCleared<T extends { key: string; lastFailure: number }>(items: T[], cleared: Record<string, number>): T[] {
  return items.filter((d) => !(cleared[d.key] && d.lastFailure <= cleared[d.key]));
}
