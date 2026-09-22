import type { PlaybackState } from "@/app/api/jellyfin/playback-state/[itemId]/route";

/**
 * Les deux réponses que le lecteur natif attend avant de pouvoir ouvrir un film — demandées dès
 * que la fiche s'ouvre, plutôt qu'à l'appui sur « Lire ».
 *
 * 22/09/2026, serveur lointain (~60 ms d'aller-retour) : entre l'appui et la première plage du
 * fichier, le lecteur posait deux questions — la description du fichier (`direct`) et l'état du
 * spectateur (`playback-state`) — puis un HEAD pour la taille. Trois allers-retours avant le
 * premier octet, alors que les deux premières réponses étaient connaissables depuis que la fiche
 * était à l'écran. Le HEAD a disparu (la taille est dans la description, voir
 * `HttpByteSource.open`) ; ce module fait disparaître les deux autres.
 *
 * Sans dépendance à SWR : `swr.ts` l'importe pour tout oublier après une lecture, et le hook qui
 * lance la demande (`usePlaybackPrefetch`) vit à côté.
 */

/**
 * La clé de la description d'un fichier — celle que l'hôte lit, et que la fiche précharge.
 *
 * Une clé SWR autant qu'une adresse : écrite deux fois à la main, un caractère de différence
 * suffirait à précharger dans le vide.
 */
export const directInfoKey = (itemId: string) => `/api/jellyfin/direct/${itemId}`;

/**
 * Au-delà, une réponse demandée d'avance n'est plus crue.
 *
 * La position de reprise change quand le titre est regardé — ici, ou sur la télé du salon — et
 * les préférences quand le compte est réglé. Trente secondes couvrent le geste qu'on veut servir
 * (ouvrir une fiche, puis Lire) sans servir une position d'il y a un quart d'heure.
 */
export const PLAYBACK_STATE_FRESH_MS = 30_000;

/** La lecture nue de l'état du spectateur, avec la garde de huit secondes de l'hôte. */
export function fetchPlaybackState(itemId: string): Promise<PlaybackState | null> {
  return fetch(`/api/jellyfin/playback-state/${itemId}`, { signal: AbortSignal.timeout(8000) })
    .then((response) => (response.ok ? (response.json() as Promise<PlaybackState>) : null))
    .catch(() => null);
}

/** Une demande par titre : la promesse, et l'instant où elle est partie. */
const prefetched = new Map<string, { at: number; state: Promise<PlaybackState | null> }>();

/**
 * Demande l'état du spectateur pour ce titre, s'il n'a pas déjà été demandé il y a peu.
 *
 * Gardée comme promesse, et non comme valeur : l'appui sur Lire suit souvent l'ouverture de la
 * fiche de moins d'un aller-retour, et c'est alors la demande en vol que le lecteur doit
 * reprendre — pas une seconde, partie derrière elle.
 */
export function prefetchPlaybackState(itemId: string): void {
  const current = prefetched.get(itemId);
  if (current && Date.now() - current.at < PLAYBACK_STATE_FRESH_MS) return;
  prefetched.set(itemId, { at: Date.now(), state: fetchPlaybackState(itemId) });
}

/**
 * Ce que la fiche a demandé pour ce titre, si c'est assez récent — et une seule fois.
 *
 * Pris, pas lu : la réponse sert l'ouverture qu'elle précède et aucune autre. Une seconde
 * lecture du même titre relit sa position, qui a bougé pendant la première. Une réponse vide
 * (serveur muet, délai dépassé) ne vaut pas mieux qu'une question neuve : on redemande.
 */
export function takePrefetchedPlaybackState(itemId: string): Promise<PlaybackState | null> | null {
  const entry = prefetched.get(itemId);
  if (!entry) return null;
  prefetched.delete(itemId);
  if (Date.now() - entry.at >= PLAYBACK_STATE_FRESH_MS) return null;
  return entry.state.then((state) => state ?? fetchPlaybackState(itemId));
}

/**
 * Tout oublier : une lecture vient de finir, ou « vu » vient d'être coché.
 *
 * Les deux changent la position qu'une réponse gardée prétend connaître. Une demande encore en
 * vol est oubliée avec les autres : son résultat n'a plus d'entrée où atterrir.
 */
export function forgetPrefetchedPlaybackState(): void {
  prefetched.clear();
}
