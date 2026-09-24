// La position d'une séance perdue, rendue à Jellyfin.
//
// Une page qu'iOS tue en arrière-plan n'envoie pas sa dernière position : Jellyfin garde celle du
// dernier battement qui lui est parvenu. Le bilan gardé sur l'appareil (`unsentStop.ts`), lui,
// connaît la vraie — et il part au lancement suivant. Le 24/09/2026, une séance a perdu le réseau
// vingt-cinq secondes avant que l'application soit quittée : Jellyfin avait 40:21, le téléphone
// 40:48, et l'épisode a repris à 40:16. Le bilan arrivé treize secondes avant la réouverture
// aurait suffi à reprendre au bon endroit.
//
// Ce bilan ne fait qu'avancer une position, jamais la reculer, et seulement si rien n'a été lu
// depuis : une séance plus récente — le même titre repris ailleurs, recommencé exprès — a toujours
// le dernier mot. Les seuils sont ceux de Jellyfin, comme pour tout arrêt (voir `playbackReport`).
//
// « Lu depuis » demande de la prudence, car Jellyfin n'écrit la position et la date de lecture
// qu'à l'arrêt — jamais pendant — et une séance dont l'appareil se tait est arrêtée par Jellyfin
// lui-même, quelques minutes plus tard : celle de Love Story à 16:50:20, cinq minutes après le
// dernier contact, datée de ce moment-là. Cette date n'est donc pas une lecture plus récente ;
// une date au-delà de `JELLYFIN_TIMEOUT_MS` en est une. Et une lecture en cours du même titre ne
// se voit pas dans la date : elle se voit dans les sessions, et elle a le dernier mot.

import { jellyfin } from "@/lib/clients/jellyfin";

const TICKS_PER_SECOND = 10_000_000;
const MIN_RESUME_PCT = 5;
const MAX_RESUME_PCT = 90;
/**
 * Jusqu'où l'arrêt que Jellyfin prononce seul peut suivre la dernière écriture du bilan : environ
 * cinq minutes de silence (mesuré), plus les 30 s entre deux écritures, avec de la marge.
 */
const JELLYFIN_TIMEOUT_MS = 10 * 60_000;
/** En deçà, l'écart ne vaut pas une écriture : le recul de reprise l'absorbe. */
const MIN_GAIN_SECONDS = 3;
/** Une lecture vivante rapporte toutes les 10 s : au-delà d'une minute sans nouvelles, elle est morte. */
const LIVE_SESSION_MS = 60_000;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Ce qui a été fait, pour la ligne du journal — jamais une erreur qui remonte. */
export async function recoverLostPosition(jfId: string | undefined, fields: Record<string, unknown>, now = Date.now()): Promise<string> {
  if (fields.why !== "lost") return "sans objet";
  const itemId = typeof fields.itemId === "string" ? fields.itemId : null;
  const at = num(fields.at);
  const lateBy = num(fields.lateByMs);
  if (!jfId || !itemId || at === null || at <= 0 || lateBy === null) return "incomplet";
  if (fields.ended === true || fields.bench) return "sans objet";
  const savedAt = now - lateBy;

  const item = await jellyfin.getItemUserData(jfId, itemId);
  const data = item.UserData;
  const runtime = item.RunTimeTicks ?? null;
  const known = (data?.PlaybackPositionTicks ?? 0) / TICKS_PER_SECOND;
  const lastPlayed = data?.LastPlayedDate ? Date.parse(data.LastPlayedDate) : 0;

  // Lu depuis, ici ou ailleurs : la séance suivante a le dernier mot.
  if (lastPlayed > savedAt + JELLYFIN_TIMEOUT_MS) return "lu depuis";
  // En cours de lecture en ce moment : c'est cette séance-là qui écrira la position, à son arrêt.
  // En cours *pour de bon* : une session qui rapporte encore. Celle de la séance perdue reste
  // listée jusqu'à ce que Jellyfin la close (~5 min) ; relancée entre-temps, l'application la
  // prenait pour une lecture en cours, et la correction était perdue (relu le 24/09/2026).
  const sessions = await jellyfin.getSessions();
  const live = sessions.some((s) => {
    if (s.UserId !== jfId || s.NowPlayingItem?.Id !== itemId) return false;
    const seen = Date.parse(s.LastPlaybackCheckIn ?? s.LastActivityDate ?? "");
    return Number.isFinite(seen) && seen > now - LIVE_SESSION_MS;
  });
  if (live) return "en cours de lecture";
  if (data?.Played && known === 0) return "déjà vu";
  if (at - known < MIN_GAIN_SECONDS) return "déjà à jour";
  const pct = runtime ? ((at * TICKS_PER_SECOND) / runtime) * 100 : null;
  if (pct !== null && (pct < MIN_RESUME_PCT || pct >= MAX_RESUME_PCT)) return "hors des seuils";

  await jellyfin.savePositionAsAdmin(jfId, itemId, Math.round(at * TICKS_PER_SECOND));
  return `avancée de ${Math.round(at - known)} s`;
}
