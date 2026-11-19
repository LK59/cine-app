// Le tri de la bibliothèque (Gestion → Tri) : les titres à examiner, les comptes et leurs scores, la
// suppression complète d'un titre. Administrateur seul (proxy.ts et `adminOnly`). DECISIONS.md §198.

export type TriKind = "movie" | "series";

/** Ce qui fait remarquer un titre, indépendamment de qui l'a demandé. */
export type TriFlag = "documentary" | "animationMovie" | "animationSeries" | "tvMovie" | "lowRating";

/** Un profil : un compte vu depuis un type d'appareil (« mathis · iPhone »). */
export interface TriProfile {
  key: string;
  user: string;
  device: string;
  /** Titres ouverts depuis ce profil (films, séries), d'après le journal du lecteur. */
  opened: number;
  /** Les genres de ce qu'il ouvre, du plus fréquent au moins fréquent. */
  topGenres: { genre: string; count: number }[];
}

export interface TriRequest {
  user: string;
  /** Profil d'appareil actif au moment de la demande, quand le journal permet de le dire. */
  device: string | null;
  at: string;
  jellyseerrRequestId: number;
}

export interface TriViewer {
  user: string;
  /** Épisodes vus ou entamés (séries), ou 1 (film). */
  played: number;
  lastPlayed: string | null;
}

export interface TriSession {
  user: string;
  device: string;
  at: string;
  /** L'épisode (série) : « S01E05 », quand le journal le dit. */
  episode: string | null;
  /** Minutes regardées, d'après la ligne `stop` de la séance. */
  watchedMin: number | null;
}

export interface TriTitle {
  kind: TriKind;
  /** L'identifiant Radarr (film) ou Sonarr (série). */
  id: number;
  title: string;
  year: number | null;
  genres: string[];
  /** Note sur 10 et sa source (IMDb pour un film, TVDB pour une série, par Radarr et Sonarr). */
  rating: number | null;
  ratingSource: "imdb" | "tvdb" | null;
  sizeBytes: number;
  added: string | null;
  episodes: { files: number; total: number } | null;
  poster: string | null;
  requests: TriRequest[];
  viewers: TriViewer[];
  /** Les séances du lecteur sur ce titre (player.log) : qui, depuis quoi, quand — les plus récentes d'abord. */
  sessions: TriSession[];
  flags: TriFlag[];
  /** 0 à 100 : plus il est haut, plus le titre mérite d'être examiné. */
  score: number;
  /** Les parts du score, pour qu'il se lise et se conteste. */
  reasons: { key: string; points: number }[];
  /** Éloignement des genres de ce titre et de ce que regarde le profil qui l'a demandé, 0 à 1. */
  genreDistance: number | null;
  jellyseerrMediaId: number | null;
}

export interface TriAccount {
  user: string;
  requests: number;
  /** Demandes dont le titre est (encore) dans la bibliothèque. */
  available: number;
  /** Parmi elles, celles que ce compte a ouvertes. */
  opened: number;
  avgRating: number | null;
  neverOpenedBytes: number;
  /** Part des demandes faites un jour où le compte en a fait au moins cinq. */
  burstShare: number;
  profiles: string[];
  last90Days: number;
  /** 0 à 100 : plus il est haut, mieux le compte demande. */
  score: number;
  parts: { key: string; points: number; max: number }[];
}

export interface TriPayload {
  computedAt: number;
  titles: TriTitle[];
  accounts: TriAccount[];
  profiles: TriProfile[];
  /** Ce que le tri a déjà supprimé : le journal (le plus récent d'abord). */
  removed: TriRemoval[];
  freedBytesTotal: number;
}

/** Ce qu'une suppression emportera — montré avant la confirmation, et vérifié de nouveau à l'exécution. */
export interface TriPlan {
  kind: TriKind;
  id: number;
  title: string;
  libraryFiles: { path: string; sizeBytes: number }[];
  torrents: { hash: string; name: string; category: string; sizeBytes: number; why: "fichier commun" | "historique" | "même contenu" }[];
  /** Octets que le disque devrait récupérer : les fichiers dont aucun autre lien ne survit. */
  freedBytesEstimate: number;
  jellyseerrMediaId: number | null;
  requests: number;
  /** Une empreinte du plan : la suppression refuse un plan qui a changé depuis l'aperçu. */
  fingerprint: string;
}

export interface TriRemoval {
  at: string;
  kind: TriKind;
  title: string;
  year: number | null;
  requestedBy: string[];
  sizeBytes: number;
  freedBytes: number | null;
  torrents: number;
  steps: { step: string; ok: boolean; detail?: string }[];
}
