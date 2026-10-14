/**
 * La forme du contrôle de la bibliothèque (DECISIONS.md §90) — partagée par l'analyse, la route et la
 * page. Des faits et des codes, jamais de phrases : la page les dit dans la langue de qui la lit.
 */

export type CheckCategory = "jellyfinOnly" | "identity" | "numbering" | "misfiled" | "hardlinks";

/** Les catégories qui demandent un geste — celles que compte la pastille de la Vue d'ensemble. */
export const ACTIONABLE_CATEGORIES: readonly CheckCategory[] = ["identity", "numbering", "misfiled"];

export const CHECK_CATEGORIES: readonly CheckCategory[] = ["identity", "numbering", "misfiled", "jellyfinOnly", "hardlinks"];

/**
 * Qui a probablement raison.
 * - `catalogue` : Radarr/Sonarr (le dossier) — c'est Jellyfin qu'il faut réaligner ;
 * - `jellyfin` : Jellyfin — c'est Radarr/Sonarr qu'il faut corriger (ou faire confiance à Jellyfin) ;
 * - `file` : le fichier n'est probablement pas le titre sous lequel Radarr l'a rangé ;
 * - `unknown` : les indices ne départagent pas ;
 * - `info` : rien à trancher (Jellyfin seul, doubles rangements).
 */
export type CheckVerdict = "catalogue" | "jellyfin" | "file" | "unknown" | "info";

export interface ExternalIds {
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
}

/** Ce que TMDB dit d'un identifiant — le titre, l'année, la durée (films) et les saisons (séries). */
export interface TmdbFacts {
  tmdbId: number;
  title: string | null;
  year: number | null;
  runtime: number | null;
  /** Saison → nombre d'épisodes (séries). */
  seasons?: Record<string, number>;
}

/** Un épisode comparé par l'arbitre : ce que disent Jellyfin, TMDB (au numéro du disque) et Sonarr. */
export interface EpisodeWitness {
  /** Le numéro du disque, « S01E13 ». */
  disk: string;
  jellyfin: string | null;
  tmdbAtDisk: string | null;
  /** Les numéros auxquels Sonarr rattache ce fichier, « S02E01 ». */
  sonarr: string[];
  sonarrTitle: string | null;
  /** Similarités 0–1 avec le titre TMDB au numéro du disque (FR puis EN, la meilleure). */
  jellyfinScore: number | null;
  sonarrScore: number | null;
}

/** Le jugement de TMDB, troisième source, sur une série en désaccord. */
export interface SeriesArbiter {
  verdict: "catalogue" | "jellyfin" | "unknown";
  /** > 0 penche pour Jellyfin, < 0 pour Sonarr ; de −1,25 à +1,25. */
  score: number;
  /** Moyennes des similarités sur les exemples (null sans titre TMDB). */
  jellyfinTitles: number | null;
  sonarrTitles: number | null;
  /** Saisons complètes dont le nombre d'épisodes du disque est celui de TMDB, de Sonarr. */
  seasonCounts: { compared: number; tmdb: number; sonarr: number; other?: number } | null;
  examples: EpisodeWitness[];
}

interface FindingBase {
  key: string;
  kind: "movie" | "series";
  title: string;
  year: number | null;
  /** Le dossier (son nom seul) — ce que l'administrateur cherche chez Radarr/Sonarr ou sur le disque. */
  folder: string | null;
  verdict: CheckVerdict;
}

export interface JellyfinOnlyFinding extends FindingBase {
  category: "jellyfinOnly";
  jellyfinId: string;
  catalogueId: number;
  ids: ExternalIds;
  /** Le service qui pourrait le suivre n'est pas configuré : rien à faire, c'est le fonctionnement normal. */
  serviceConfigured: boolean;
}

export interface IdentityFinding extends FindingBase {
  category: "identity";
  catalogueId: number;
  jellyfinId: string;
  catalogue: ExternalIds;
  jellyfin: ExternalIds & { name: string; year: number | null };
  /** Ce que TMDB dit des deux identités, quand il les connaît. */
  catalogueTmdb: TmdbFacts | null;
  jellyfinTmdb: TmdbFacts | null;
  /** Films : la durée du fichier, en minutes. */
  fileMinutes: number | null;
  /** Séries : l'arbitre, et l'exception posée. */
  arbiter?: SeriesArbiter | null;
  trusted?: boolean;
}

export interface NumberingFinding extends FindingBase {
  category: "numbering";
  sonarrId: number;
  seriesType: string | null;
  /** Épisodes du disque que Sonarr rattache à un autre numéro. */
  mismatched: number;
  /** Épisodes du disque que Sonarr rattache (comparés). */
  compared: number;
  /** Épisodes du disque que Sonarr ne rattache à rien. */
  unattached: number;
  arbiter: SeriesArbiter | null;
  trusted: boolean;
}

export type MisfiledSignal = "duration" | "nameYear" | "jellyfinRuntime";

export interface MisfiledFinding extends FindingBase {
  category: "misfiled";
  catalogueId: number;
  jellyfinId: string | null;
  signals: MisfiledSignal[];
  fileMinutes: number | null;
  expectedMinutes: number | null;
  /** Le nom d'origine du fichier (avant Radarr) et les années qu'on y lit. */
  originalName: string | null;
  nameYears: number[];
  /** Ce que Jellyfin croit voir, si c'est un autre film. */
  jellyfinTmdb: TmdbFacts | null;
}

export interface HardlinkFinding extends FindingBase {
  category: "hardlinks";
  /** Les deux dossiers de titre, chacun sous sa racine : « tv/Berlin (2023) ». */
  folders: [string, string];
  files: number;
}

export type CheckFinding = JellyfinOnlyFinding | IdentityFinding | NumberingFinding | MisfiledFinding | HardlinkFinding;

export type SourceState = "ok" | "unconfigured" | "down";

export interface LibraryCheckResult {
  version: number;
  computedAt: number;
  durationMs: number;
  sources: { radarr: SourceState; sonarr: SourceState; jellyfin: SourceState; tmdb: SourceState; media: "ok" | "absent" };
  counts: Record<CheckCategory, number>;
  findings: CheckFinding[];
}

export interface LibraryCheckStatus {
  running: boolean;
  startedAt: number | null;
  progress: { step: string; done: number; total: number } | null;
  /** La dernière analyse qui a échoué, si elle est plus récente que le résultat. */
  error: string | null;
  result: LibraryCheckResult | null;
  /** Les séries où l'exception est posée — y compris celles que la dernière analyse ne montre plus. */
  trusted: { sonarrId: number; title: string | null; createdAt: number }[];
}
