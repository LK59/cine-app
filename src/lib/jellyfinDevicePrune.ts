// Le ménage quotidien des appareils « CineApp » chez Jellyfin.
//
// Chaque connexion à l'application inscrit un appareil à elle (`cine-app-<aléatoire>`, voir
// `jellyfinRevoke.ts`). La déconnexion le révoque depuis le 24/09/2026, une session expirée aussi
// quand une connexion passe par là — mais une session qu'on laisse simplement mourir dans un
// navigateur qu'on n'ouvre plus garde le sien pour toujours, avec un jeton valide. Constat du
// 29/09/2026 : trente-deux appareils « CineApp », dont treize pour un seul compte, et vingt-sept
// qu'aucune session enregistrée ne réclamait plus.
//
// Ne tombe que ce qui remplit les trois conditions à la fois — `AppName` « CineApp », identifiant
// `cine-app-…` (le nôtre), dernière activité lisible et vieille de plus de trente jours. La
// télévision, Jellyfin web, les applications mobiles ne sont jamais touchées ; une date absente ou
// illisible non plus : on ne supprime pas ce qu'on ne sait pas dater.
//
// **Et jamais l'appareil d'une session encore vivante.** On aurait pu croire la garde inutile :
// Jellyfin date `DateLastActivity` à chaque requête faite avec le jeton, donc une session utilisée
// n'aurait jamais un appareil inactif trente jours. C'est faux ici, mesuré le 29/09/2026 : une
// session vue il y a une heure avait un appareil muet depuis vingt-cinq. Une session se prolonge à
// chaque requête (`proxy.ts`, sept jours glissants, sans plafond) alors que beaucoup de ses
// requêtes n'emploient pas son jeton — le catalogue passe par la clé d'administration, le cinéma
// s'ouvre sur le cache de l'appareil, la gestion ne parle presque jamais à Jellyfin au nom du
// compte. Un administrateur qui ne fait que gérer pendant un mois perdrait le jeton de sa session
// sans s'être déconnecté. D'où la liste des appareils des sessions encore valides, lue avant de
// supprimer quoi que ce soit.

import { config } from "@/lib/config";
import { sessionDb } from "@/lib/db";
import { logAuthEvent } from "@/lib/eventLogs";
import { upstreamSignal, UPSTREAM_TIMEOUT_MS } from "@/lib/http";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { logError } from "@/lib/logger";

/** Trente jours sans la moindre requête : plus personne ne se sert de ce jeton. */
export const DEVICE_MAX_IDLE_MS = 30 * 24 * 3600_000;

/**
 * Pas plus par passage. Prudence, pas débit : trente-deux appareils en tout au 29/09/2026 ; si un
 * jour un passage en trouvait davantage, c'est plus probablement une date mal lue qu'un vrai stock,
 * et le reste attendra le lendemain.
 */
export const MAX_DELETIONS_PER_RUN = 50;

const PRUNE_INTERVAL_MS = 24 * 3600_000;
/** Loin du démarrage, qui a déjà le cache, les affiches et les sondes à faire. */
const STARTUP_DELAY_MS = 15 * 60_000;

export interface PrunableDevice {
  Id?: string;
  AppName?: string;
  LastUserName?: string;
  DateLastActivity?: string;
}

/**
 * Les appareils à supprimer, dans l'ordre où la liste les donne, au plus `limit`.
 *
 * Pure : ni horloge ni base, pour que chaque refus se teste tel quel.
 */
export function selectPrunableDevices(
  devices: readonly PrunableDevice[],
  now: number,
  protectedIds: ReadonlySet<string> = new Set(),
  limit = MAX_DELETIONS_PER_RUN
): PrunableDevice[] {
  const chosen: PrunableDevice[] = [];
  for (const device of devices) {
    if (chosen.length >= limit) break;
    if (device.AppName !== "CineApp") continue;
    if (typeof device.Id !== "string" || !device.Id.startsWith("cine-app-")) continue;
    if (protectedIds.has(device.Id)) continue;
    if (typeof device.DateLastActivity !== "string") continue;
    const last = Date.parse(device.DateLastActivity);
    // `NaN` échoue à toutes les comparaisons : écrit ainsi, une date illisible est gardée.
    if (!(now - last > DEVICE_MAX_IDLE_MS)) continue;
    chosen.push(device);
  }
  return chosen;
}

/** Un passage. Ne lève jamais : un Jellyfin absent se retente au passage suivant. */
export async function pruneJellyfinDevices(now = Date.now()): Promise<{ deleted: number }> {
  const base = config.jellyfin.url;
  const headers = jellyfinAuthHeaders(config.jellyfin.apiKey);
  let devices: PrunableDevice[];
  let protectedIds: Set<string>;
  try {
    const res = await fetch(`${base}/Devices`, { headers, signal: upstreamSignal(UPSTREAM_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`GET /Devices : HTTP ${res.status}`);
    const body = (await res.json()) as { Items?: PrunableDevice[] };
    devices = Array.isArray(body?.Items) ? body.Items : [];
    protectedIds = new Set(sessionDb.liveJfDevices(now));
  } catch (err) {
    logError("jellyfin.device-prune", err);
    return { deleted: 0 };
  }

  const byUser = new Map<string, number>();
  let deleted = 0;
  for (const device of selectPrunableDevices(devices, now, protectedIds)) {
    try {
      const res = await fetch(`${base}/Devices?id=${encodeURIComponent(device.Id!)}`, {
        method: "DELETE",
        headers,
        signal: upstreamSignal(UPSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`DELETE /Devices : HTTP ${res.status}`);
      deleted++;
      const user = device.LastUserName || "?";
      byUser.set(user, (byUser.get(user) ?? 0) + 1);
    } catch (err) {
      logError("jellyfin.device-prune", err, { device: device.Id });
    }
  }

  if (deleted) {
    console.info(`[jellyfin.device-prune] ${deleted} appareil(s) CineApp inactif(s) depuis 30 jours supprimé(s)`);
    // Au journal des connexions, compte par compte : c'est là que l'activité lit la vie des
    // sessions et de leurs jetons, et un jeton qui disparaît sans déconnexion doit s'y expliquer.
    for (const [user, count] of byUser) logAuthEvent("devices-pruned", { user, count });
  }
  return { deleted };
}

export function startJellyfinDevicePruneCron(): void {
  if (!config.jellyfin.apiKey) return;
  const startupDelay = setTimeout(() => void pruneJellyfinDevices(), STARTUP_DELAY_MS);
  startupDelay.unref?.();
  const interval = setInterval(() => void pruneJellyfinDevices(), PRUNE_INTERVAL_MS);
  interval.unref?.();
}
