// Ce qu'un signalement emporte des journaux, figé au moment où il part.
//
// Figé plutôt que relu à chaque ouverture : les journaux tournent, et le ticket doit rester
// lisible des mois après. Le choix de ce qui compte est fait ici, une fois : les séances de lecture
// de la personne dans les 48 dernières heures — et celles du titre choisi, sur trente jours —, ses
// erreurs de navigateur et du serveur, ses connexions, et les notifications qu'elle a reçues.

import { HEAVY_FIELDS, readRecords, type LogRecord } from "@/lib/activity/logReader";
import { buildSeances, type Seance } from "@/lib/activity/seances";

const HOUR = 60 * 60 * 1000;

/** Une ligne de journal sans ce qui l'alourdit : de quoi la lire dans le ticket. */
function slim(r: LogRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    // Seulement les marqueurs des champs lourds, que la liste remplace par `true` : retirer tout
    // `true` emportait aussi `ended`, `cast`, `local`… des lignes figées (relu le 24/09/2026).
    if (k.startsWith("_") || (v === true && HEAVY_FIELDS.has(k))) continue;
    out[k] = v;
  }
  out.at = r._t;
  return out;
}

export interface ReportLogs {
  capturedAt: number;
  seances: Seance[];
  itemSeances: Seance[];
  errors: Record<string, unknown>[];
  auth: Record<string, unknown>[];
  notifications: Record<string, unknown>[];
}

export function captureReportLogs(userName: string, item: { id: string | null; title: string | null }, now = Date.now()): ReportLogs {
  const lower = userName.toLowerCase();
  const mine = (r: LogRecord) => String(r.user ?? "").toLowerCase() === lower;
  const recentStart = now - 48 * HOUR;

  const seances = buildSeances(readRecords("player", now - 30 * 24 * HOUR)).filter((s) => s.user.toLowerCase() === lower);
  const recent = seances.filter((s) => s.start >= recentStart).slice(0, 20);
  // Une série est choisie par son nom, et le journal parle d'épisodes : on les reconnaît aussi au titre.
  const itemSeances = item.id || item.title
    ? seances
        .filter((s) => (item.id && s.itemId === item.id) || (item.title && s.title.toLowerCase().startsWith(item.title.toLowerCase())))
        .slice(0, 20)
    : [];

  return {
    capturedAt: now,
    seances: recent,
    itemSeances,
    errors: readRecords("server", recentStart).filter((r) => r._t >= recentStart && mine(r)).slice(-40).map(slim),
    auth: readRecords("auth", now - 7 * 24 * HOUR).filter(mine).slice(-20).map(slim),
    notifications: readRecords("notifications", now - 7 * 24 * HOUR)
      .filter((r) => Array.isArray(r.recipients) && (r.recipients as { user?: string }[]).some((x) => String(x.user ?? "").toLowerCase() === lower))
      .slice(-20)
      .map(slim),
  };
}
