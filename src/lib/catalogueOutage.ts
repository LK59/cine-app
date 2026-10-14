/**
 * Ce que le cinéma fait d'un Jellyfin en panne — décidé une fois pour le bureau et le téléphone
 * (14/10/2026, DECISIONS.md §92).
 *
 * Le serveur sert alors le dernier catalogue gardé pour le compte (`catalogueFallback.ts`), marqué
 * `stale` et/ou `jellyfinDown`. Trois conséquences, chacune ici et nulle part ailleurs :
 *
 *  - **le bandeau** : `outageOf` dit s'il faut l'afficher ;
 *  - **la relecture** : `useCatalogueOutage` relit le catalogue toutes les 30 s tant qu'il est
 *    marqué (`needsOutageRefresh`), si bien que le bandeau disparaît seul au retour de Jellyfin, sans recharger la page — et
 *    ne relit rien de plus en temps normal (le catalogue reste figé, `liveFeedOptions` à part) ;
 *  - **le bouton Lecture** : `playBlockedByOutage`, appelé par `PlaybackProvider.play`, refuse
 *    d'ouvrir le lecteur pendant la panne et le dit (un message, pas un écran noir, pas un repli
 *    vers le lecteur serveur qui a besoin du même Jellyfin).
 */

/** Les marques qu'une réponse du catalogue peut porter (`CatalogueOutageFlags` côté serveur). */
export interface OutageMarks {
  stale?: boolean;
  jellyfinDown?: boolean;
  savedAt?: number;
}

export interface CatalogueOutage {
  /** Jellyfin réputé hors ligne : parcourir oui, lire non. */
  jellyfinDown: boolean;
  /** Le catalogue montré est le dernier gardé, pas celui d'aujourd'hui. */
  stale: boolean;
}

/** L'état de panne d'après les deux catalogues tenus — l'un suffit à le dire. */
export function outageOf(...payloads: (OutageMarks | null | undefined)[]): CatalogueOutage {
  return {
    jellyfinDown: payloads.some((p) => p?.jellyfinDown === true),
    stale: payloads.some((p) => p?.stale === true),
  };
}

/** Le rythme de relecture d'un catalogue marqué : celui du coupe-circuit du serveur. */
export const OUTAGE_REFRESH_MS = 30_000;

/**
 * Faut-il relire les catalogues toutes les `OUTAGE_REFRESH_MS` ? Tant qu'ils sont marqués — et
 * jamais sinon : le chemin heureux ne relit rien de plus.
 *
 * Pas par le `refreshInterval` de SWR : sa minuterie ne se lance qu'au montage, et lit alors une
 * donnée encore absente — la fonction rendait 0, et la relecture ne partait jamais (vu au test isolé
 * du 14/10/2026 : bandeau resté 90 s après le retour de Jellyfin). `useCatalogueOutage` tient sa
 * propre minuterie.
 */
export function needsOutageRefresh(outage: CatalogueOutage): boolean {
  return outage.jellyfinDown || outage.stale;
}

// ─── Le bouton Lecture pendant la panne ────────────────────────────────────────────────────────

let down = false;
let onBlocked: (() => void) | null = null;

/** Posé par l'accueil (`useCatalogueOutage`) à chaque réponse du catalogue. */
export function notePlaybackOutage(jellyfinDown: boolean): void {
  down = jellyfinDown;
}

/** Ce que l'accueil fait d'un appui refusé : le message, et une relecture du catalogue. */
export function onPlayBlockedByOutage(listener: (() => void) | null): void {
  onBlocked = listener;
}

/**
 * L'ouverture du lecteur est-elle refusée ? Vrai pendant une panne connue — et l'appui est alors
 * signalé à l'accueil, qui le dit. Gardé : un message qui échoue ne doit pas empêcher de refuser.
 */
export function playBlockedByOutage(): boolean {
  if (!down) return false;
  try {
    onBlocked?.();
  } catch {
    // Le refus tient, même sans message.
  }
  return true;
}

/** Pour les tests. */
export function resetPlaybackOutage(): void {
  down = false;
  onBlocked = null;
}

/**
 * Ce que le filet des adresses sans fiche (`useRepairUnresolvedSheet`) doit savoir d'une panne —
 * calculé ici pour les deux accueils : le catalogue du titre demandé (films si `film` est posé,
 * séries sinon) a-t-il échoué sans rien laisser, et Jellyfin est-il réputé hors ligne.
 */
export function sheetRepairDuring(
  film: number | null,
  moviesError: unknown,
  movies: unknown,
  seriesError: unknown,
  series: unknown,
  outage: CatalogueOutage
): { failed: boolean; outage: boolean } {
  const [error, data] = film !== null ? [moviesError, movies] : [seriesError, series];
  return { failed: !!error && data === undefined, outage: outage.jellyfinDown };
}
