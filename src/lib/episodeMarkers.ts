import type { EpisodeTimestamps } from "@/lib/clients/jellyfin";

/** Ce que le lecteur reçoit des repères d'un épisode — les deux routes de lecture le donnent ainsi. */
export interface PlayerMarkers {
  /** Où court le générique d'ouverture, quand Jellyfin a analysé l'épisode. */
  introSkip: { start: number; end: number } | null;
  /** Où court le « précédemment dans… » (DECISIONS.md §65). */
  recapSkip: { start: number; end: number } | null;
  /** Où commence le générique de fin, quand la carte « Épisode suivant » paraît. */
  creditsStart: number | null;
}

/**
 * Les repères tels que les lit le lecteur, écrits une fois pour la route native (`direct`) et celle
 * du lecteur serveur (`playback/start`), qui recopiaient chacune la conversion — le récap n'aurait
 * été ajouté qu'à l'une. Ce qui se lit dans les segments de Jellyfin, lui, est décidé par
 * `timestampsFromSegments` (src/lib/clients/jellyfin.ts).
 */
export function playerMarkers(timestamps: EpisodeTimestamps | null | undefined): PlayerMarkers {
  const span = (s: { Start: number; End: number; Valid: boolean } | undefined) => (s?.Valid ? { start: s.Start, end: s.End } : null);
  return {
    introSkip: span(timestamps?.Introduction),
    recapSkip: span(timestamps?.Recap),
    creditsStart: timestamps?.Credits?.Valid ? timestamps.Credits.Start : null,
  };
}
