import { readRecords, type LogRecord } from "@/lib/activity/logReader";
import { listOfflineCopies, offlineDiskUsage, OFFLINE_KEEP_DAYS, type OfflineCopy } from "@/lib/offline/jobs";
import { resolveOfflineTitles } from "@/lib/offline/events";

/**
 * Les téléchargements vus de l'Activité (19/10/2026, demandé par l'administrateur : « les logs
 * doivent indiquer les téléchargements des gens […] où on doit aussi voir les fichiers actuellement
 * faits et prêts »). Deux choses côte à côte : les versions que le serveur garde en ce moment
 * (`offline_jobs`), et ce qui s'est passé — les lignes `offline` et `download` de `server.log`.
 */

/** Jusqu'où remontent les gestes affichés ; la vue Journaux va plus loin. */
export const DOWNLOAD_EVENTS_DAYS = 14;
/** Combien de lignes partent vers la page, les plus récentes. */
export const DOWNLOAD_EVENTS_MAX = 300;

export interface OfflineCopyView extends OfflineCopy {
  title: string | null;
  audio: string | null;
}

export interface DownloadsOverview {
  now: number;
  keepDays: number;
  /** Jusqu'où remontent `events`, en jours. */
  eventsDays: number;
  copies: OfflineCopyView[];
  totals: {
    ready: number;
    preparing: number;
    queued: number;
    failed: number;
    /** La place que prennent les versions sur le disque des données. */
    usedBytes: number;
    /** Ce qui reste sur ce disque — `null` quand le système ne le dit pas. */
    freeBytes: number | null;
  };
  /** Les gestes des `DOWNLOAD_EVENTS_DAYS` derniers jours, le plus récent d'abord. */
  events: LogRecord[];
}

/** Une ligne de téléchargement : hors ligne (`offline`) ou fichier d'origine (`download`). */
export function isDownloadLine(r: Record<string, unknown>): boolean {
  return r.scope === "offline" || r.scope === "download";
}

export function recentDownloadEvents(now: number, days = DOWNLOAD_EVENTS_DAYS, max = DOWNLOAD_EVENTS_MAX): LogRecord[] {
  const since = now - days * 24 * 3600_000;
  const lines = readRecords("server", since).filter((r) => r._t >= since && isDownloadLine(r));
  return lines.slice(-max).reverse();
}

export async function downloadsOverview(now = Date.now()): Promise<DownloadsOverview> {
  const copies = listOfflineCopies();
  // Un seul appel à Jellyfin pour les titres qu'on ne connaît pas encore (après un redémarrage).
  const names = await resolveOfflineTitles(copies.map((c) => c.itemId));
  const { usedBytes, freeBytes } = offlineDiskUsage();
  return {
    now,
    keepDays: OFFLINE_KEEP_DAYS,
    eventsDays: DOWNLOAD_EVENTS_DAYS,
    copies: copies.map((c) => ({ ...c, title: names.get(c.itemId)?.title ?? null, audio: names.get(c.itemId)?.audio[c.audioIndex] ?? null })),
    totals: {
      ready: copies.filter((c) => c.status === "done").length,
      preparing: copies.filter((c) => c.status === "running").length,
      queued: copies.filter((c) => c.status === "queued").length,
      failed: copies.filter((c) => c.status === "failed").length,
      usedBytes,
      freeBytes,
    },
    events: recentDownloadEvents(now),
  };
}
