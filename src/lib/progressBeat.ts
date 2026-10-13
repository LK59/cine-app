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
