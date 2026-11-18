/**
 * Le battement de lecture vient-il de passer ? — lu par la présence et par le sondage de maintenance
 * (13/10/2026).
 *
 * Pendant un film, trois minuteurs réveillaient la radio chacun pour soi : le battement de lecture
 * (`usePlaybackSession`, ≈ 320 POST/h au relevé du 13/10, ramené à ~120), la présence
 * (`PresencePinger`, ~73/h) et l'état de maintenance (`useMaintenance`, 60/h). Or la route du
 * battement répond déjà l'état de maintenance (`noteMaintenanceState`) et enregistre la présence de
 * l'appelant (`recordPlaybackBeat`). Tant qu'un battement a réussi récemment, les deux autres se
 * taisent ; s'il cesse (lecteur arrêté sur une erreur, battements refusés), ils reprennent d'eux-mêmes
 * — un filet, pas une seconde source.
 *
 * Un module et pas un contexte React : les trois vivent dans des arbres différents (le lecteur, la
 * racine), et le fait est un horodatage.
 */

/**
 * Un battement plus ancien ne compte plus : le battement en pause part toutes les 60 s, plus la
 * seconde de son minuteur — 90 s laissent une marge sans couvrir un battement manqué.
 */
export const PROGRESS_BEAT_FRESH_MS = 90_000;

let lastBeatAt = 0;

/** Un battement de lecture accepté par le serveur (réponse 2xx). */
export function noteProgressBeat(now = Date.now()): void {
  lastBeatAt = now;
}

/** La séance de lecture est close : la présence et le sondage reprennent leur propre rythme. */
export function forgetProgressBeat(): void {
  lastBeatAt = 0;
}

export function progressBeatFresh(now = Date.now()): boolean {
  return lastBeatAt > 0 && now - lastBeatAt < PROGRESS_BEAT_FRESH_MS;
}

/**
 * Le dernier relevé de position envoyé à Jellyfin pour un titre, et s'il est passé (18/11/2026).
 *
 * *Drive*, ce jour-là : fermé à 96 % (l'arrêt est arrivé, Jellyfin l'a noté), rouvert dix secondes plus tard depuis
 * la fiche à 30 min de la fin — la position que Jellyfin avait juste avant l'arrêt. Tous les relevés avaient reçu
 * « ok », sans qu'on puisse dire quelle position ils portaient. Le bilan `stop` la porte désormais
 * (`diag.beatPos`, `diag.beatAgoS`, `diag.beatOk`) : un écart avec `at` dit un lecteur qui relève une position
 * figée.
 */
const lastBeats = new Map<string, { pos: number; at: number; ok: boolean }>();
const LAST_BEATS_MAX = 20;

export function noteBeatPosition(itemId: string, seconds: number, ok: boolean, now = Date.now()): void {
  if (!Number.isFinite(seconds)) return;
  lastBeats.delete(itemId);
  lastBeats.set(itemId, { pos: seconds, at: now, ok });
  if (lastBeats.size > LAST_BEATS_MAX) lastBeats.delete(lastBeats.keys().next().value!);
}

/** Les champs du bilan : rien si aucun relevé n'est parti pour ce titre. */
export function beatStopFields(itemId: string, now = Date.now()): Record<string, number | boolean> {
  const beat = lastBeats.get(itemId);
  if (!beat) return {};
  return {
    "diag.beatPos": Math.round(beat.pos * 10) / 10,
    "diag.beatAgoS": Math.round((now - beat.at) / 1000),
    ...(beat.ok ? {} : { "diag.beatOk": false }),
  };
}
