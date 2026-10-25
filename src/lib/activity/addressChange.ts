// Qui est passé à la nouvelle adresse, et qui ouvre encore l'ancienne (23/10/2026, DECISIONS.md §119).
//
// L'administrateur annonce une nouvelle adresse (`NEWS_LATERNA_ADDRESS`, §118) et garde l'ancienne
// en service à côté ; il ne peut éteindre l'ancienne que lorsque plus personne ne s'en sert. Rien ne
// le disait : le passage (`auth.log`) dit qu'un compte a *demandé* à changer, pas qu'il ouvre depuis
// la nouvelle, ni qu'il y a installé l'application. Les ouvertures du cinéma (`startup.log`, ligne
// `ouverture`) portent depuis ce jour le nom d'hôte de la requête (`host`, lu par le serveur) et
// déjà `standalone` : de quoi le dire compte par compte. Lecture seule, aucun stockage de plus.
// « Installée » se lit dans `installedApp` depuis le 25/10/2026 — voir `installedOpening`.

import { readRecords, type LogRecord } from "@/lib/activity/logReader";
import { laternaAddress } from "@/lib/news/pageLaterna";

/**
 * Le jour où une seconde adresse a existé : le 23/10/2026 à minuit, heure du foyer — le
 * déploiement de la 10.0. Une ouverture **sans `host`** (le champ n'existait pas encore) vaut
 * l'ancienne adresse si elle est antérieure — il n'y en avait qu'une —, et « adresse inconnue »
 * après : entre ce déploiement et celui qui écrit `host`, elle peut être l'une ou l'autre. « Depuis
 * le changement », c'est depuis ce jour.
 */
export const ADDRESS_CHANGE_START = new Date(2026, 9, 23).getTime();

/** Jusqu'où remonter avant le changement pour dater la dernière ouverture de l'ancienne adresse. */
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

export type AddressChangeStatus =
  /** Ouvert sur la nouvelle adresse, en application installée au moins une fois. */
  | "movedInstalled"
  /** Ouvert sur la nouvelle adresse, jamais en application installée. */
  | "moved"
  /** Ouvert depuis le changement, seulement sur l'ancienne adresse. */
  | "old"
  /** Ouvert depuis le changement, mais par des lignes d'avant `host` : impossible de dire où. */
  | "unknown"
  /** Aucune ouverture depuis le changement. */
  | "never";

export interface AddressChangeRow {
  user: string;
  status: AddressChangeStatus;
  /** La dernière ouverture sur l'ancienne adresse (lignes sans `host` d'avant le changement comprises). */
  lastOld: number | null;
  /** La dernière ouverture sur la nouvelle adresse. */
  lastNew: number | null;
  /** La nouvelle adresse a-t-elle été ouverte en application installée ? */
  newInstalled: boolean;
  /** La dernière ouverture sans adresse connue, depuis le changement. */
  lastUnknown: number | null;
  /** Le dernier passage demandé (sur l'ancienne) et reçu (sur la nouvelle), `auth.log`. */
  passageRequested: number | null;
  passageReceived: number | null;
}

export interface AddressChangeOverview {
  /** La nouvelle adresse (nom d'hôte seul) ; `null` : aucune n'est annoncée, la vue ne s'affiche pas. */
  newHost: string | null;
  since: number;
  /** L'heure du serveur, contre laquelle la vue écrit « il y a … ». */
  now: number;
  rows: AddressChangeRow[];
}

/** Ceux qui sont encore sur l'ancienne d'abord : c'est eux que l'administrateur doit aller voir. */
const STATUS_ORDER: Record<AddressChangeStatus, number> = { old: 0, never: 1, unknown: 2, moved: 3, movedInstalled: 4 };

/** La nouvelle adresse du réglage, réduite à son nom d'hôte (sans port) — celui que `host` porte. */
export function newHostOf(raw: string | null | undefined): string | null {
  const address = laternaAddress(raw);
  return address ? address.replace(/:\d+$/, "").toLowerCase() : null;
}

/** Où une ouverture a eu lieu, selon la règle de `ADDRESS_CHANGE_START`. */
export function addressOf(r: Pick<LogRecord, "_t"> & { host?: unknown }, newHost: string): "old" | "new" | "unknown" {
  if (typeof r.host === "string" && r.host) return r.host.toLowerCase() === newHost ? "new" : "old";
  return r._t < ADDRESS_CHANGE_START ? "old" : "unknown";
}

const max = (a: number | null, b: number): number => (a === null || b > a ? b : a);

/** Une ouverture dans les minutes qui suivent un passage reçu : la vue intégrée de l'ancienne application. */
const PASSAGE_VIEW_MS = 5 * 60 * 1000;

/**
 * Une ouverture de l'application installée. `installedApp` le dit depuis le 25/10/2026 ; avant,
 * seul `standalone` existait, vrai aussi dans la vue intégrée qu'ouvre le passage sur iPhone — une
 * telle ligne ne compte que loin d'un passage reçu par ce compte.
 */
export function installedOpening(r: { _t: number; standalone?: unknown; installedApp?: unknown }, passagesReceived: readonly number[]): boolean {
  if (typeof r.installedApp === "boolean") return r.installedApp;
  if (r.standalone !== true) return false;
  return !passagesReceived.some((at) => r._t >= at && r._t - at <= PASSAGE_VIEW_MS);
}

/**
 * Le calcul, à partir de lignes déjà lues — pour les tests, des lignes factices. `users` : les
 * comptes du foyer, par nom (le `user` des deux journaux est le nom Jellyfin), comparés sans casse.
 */
export function addressChangeRows(users: readonly string[], startup: readonly LogRecord[], auth: readonly LogRecord[], newHost: string): AddressChangeRow[] {
  const rows = new Map<string, AddressChangeRow>();
  for (const user of users) {
    rows.set(user.toLowerCase(), { user, status: "never", lastOld: null, lastNew: null, newInstalled: false, lastUnknown: null, passageRequested: null, passageReceived: null });
  }
  // Les passages reçus par compte, pour lire les ouvertures d'avant `installedApp` (ci-dessous).
  const received = new Map<string, number[]>();
  for (const r of auth) {
    if (r.kind !== "passage-received") continue;
    const key = String(r.user ?? "").toLowerCase();
    received.set(key, [...(received.get(key) ?? []), r._t]);
  }
  for (const r of startup) {
    if (r.kind !== "ouverture") continue;
    const row = rows.get(String(r.user ?? "").toLowerCase());
    if (!row) continue;
    const where = addressOf(r, newHost);
    if (where === "new") {
      row.lastNew = max(row.lastNew, r._t);
      if (installedOpening(r, received.get(String(r.user ?? "").toLowerCase()) ?? [])) row.newInstalled = true;
    } else if (where === "old") row.lastOld = max(row.lastOld, r._t);
    else row.lastUnknown = max(row.lastUnknown, r._t);
  }
  for (const r of auth) {
    if (r._t < ADDRESS_CHANGE_START) continue;
    const row = rows.get(String(r.user ?? "").toLowerCase());
    if (!row) continue;
    if (r.kind === "passage-requested") row.passageRequested = max(row.passageRequested, r._t);
    else if (r.kind === "passage-received") row.passageReceived = max(row.passageReceived, r._t);
  }
  for (const row of rows.values()) {
    if (row.lastNew !== null) row.status = row.newInstalled ? "movedInstalled" : "moved";
    else if (row.lastOld !== null && row.lastOld >= ADDRESS_CHANGE_START) row.status = "old";
    else if (row.lastUnknown !== null) row.status = "unknown";
    else row.status = "never";
  }
  const recent = (r: AddressChangeRow) => Math.max(r.lastOld ?? 0, r.lastNew ?? 0, r.lastUnknown ?? 0);
  return [...rows.values()].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || recent(b) - recent(a) || a.user.localeCompare(b.user));
}

/** La vue, lue dans les journaux (archives comprises) ; `newHost: null` sans nouvelle adresse annoncée. */
export function addressChange(users: readonly string[], rawNewAddress: string | null | undefined, now = Date.now()): AddressChangeOverview {
  const newHost = newHostOf(rawNewAddress);
  if (!newHost) return { newHost: null, since: ADDRESS_CHANGE_START, now, rows: [] };
  const from = ADDRESS_CHANGE_START - LOOKBACK_MS;
  const startup = readRecords("startup", from).filter((r) => r._t >= from);
  const auth = readRecords("auth", ADDRESS_CHANGE_START).filter((r) => r._t >= ADDRESS_CHANGE_START);
  return { newHost, since: ADDRESS_CHANGE_START, now, rows: addressChangeRows(users, startup, auth, newHost) };
}
