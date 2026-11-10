/**
 * Les formes que la page Configuration → Synchro des sous-titres reçoit (DECISIONS.md §141) — ici, sans rien du
 * serveur, pour que la page les importe.
 */

export type SyncVerdict = "ok" | "décalé" | "dérive" | "incertain" | "montage" | "image" | "peu-de-répliques" | "erreur";
export type SyncStatus = "measured" | "applied" | "rejected";
export type SyncFilter = "affected" | "measured" | "all";
export type SyncAction = "apply" | "reject" | "reset";

/** Les verdicts qui disent « à corriger » — ce que montre le filtre « Affectés ». */
export const AFFECTED_VERDICTS: readonly SyncVerdict[] = ["décalé", "dérive", "montage"];
/** Ce qu'un « Recaler » d'une saison, d'une série ou d'un élément applique : une mesure fiable d'un décalage ou d'une dérive. */
export const APPLICABLE_VERDICTS: readonly SyncVerdict[] = ["décalé", "dérive"];

export interface SyncTrackView {
  trackKey: string;
  kind: "embedded" | "external";
  codec: string | null;
  language: string | null;
  title: string | null;
  forced: boolean;
  hi: boolean;
  offset: number | null;
  scale: number | null;
  scaleLabel: string | null;
  z: number | null;
  madMs: number | null;
  windows: number | null;
  inliers: number | null;
  maxErrorS: number | null;
  confidence: string | null;
  verdict: SyncVerdict;
  reliable: boolean;
  status: SyncStatus;
  measuredAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  /** Le fichier a changé depuis la mesure : jamais appliquée, à mesurer de nouveau. `null` : pas vérifié. */
  stale: boolean | null;
}

export interface SyncJobView {
  state: "queued" | "done" | "failed";
  error: string | null;
  launchedAt: number;
}

export interface SyncItemView {
  itemId: string;
  kind: "Movie" | "Episode";
  title: string;
  season: number | null;
  episode: number | null;
  job: SyncJobView | null;
  tracks: SyncTrackView[];
}

export interface SyncCounts {
  items: number;
  measured: number;
  affected: number;
  applied: number;
  pending: number;
}

export interface SyncSeasonView {
  season: number | null;
  counts: SyncCounts;
  /** Seulement à la lecture d'une série (`?series=`). */
  episodes?: SyncItemView[];
}

export interface SyncSeriesView {
  seriesId: string;
  title: string;
  counts: SyncCounts;
  seasons: SyncSeasonView[];
}

export interface SyncTreePayload {
  configured: boolean;
  unavailable?: boolean;
  filter: SyncFilter;
  totals: SyncCounts;
  /** Les mesures demandées et pas encore revenues, toutes passes confondues. */
  pending: number;
  movies: SyncItemView[];
  series: SyncSeriesView[];
}

export interface SyncSeriesPayload {
  configured: boolean;
  seriesId: string;
  seasons: SyncSeasonView[];
}

export type SyncScanScope =
  | { scope: "item"; itemId: string }
  | { scope: "season"; seriesId: string; season: number }
  | { scope: "series"; seriesId: string }
  | { scope: "movies"; itemIds: string[] };

export type SyncDecideScope = SyncScanScope | { scope: "track"; itemId: string; trackKey: string };
