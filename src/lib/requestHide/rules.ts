// Le masquage des demandes pour un compte (01/11/2026) — les règles, sans réseau ni base.
//
// Une installation veut un compte (la télévision du salon) qui ne voie pas ce que les autres comptes
// ont demandé : « tous sauf certains ». Jellyfin sait déjà cacher un titre à un compte — un tag bloqué
// dans sa politique, appliqué par le serveur à toutes les applications, épisodes compris (vérifié le
// 01/11/2026 : une série étiquetée, 88 épisodes, 0 pour le compte). Ce qui manquait, c'est la liste.
//
// La vérité vit ici (`request_hide`), pas dans les tags de Jellyfin : ses tags sont aussi les mots-clés
// de TMDB, qu'une actualisation de métadonnées réécrit. La tâche (`run.ts`) recopie la liste en tag.
//
// Les règles, voulues ainsi :
// - un titre est *candidat* quand il a été demandé et qu'aucune de ses demandes ne vient d'un compte
//   gardé ; un titre ajouté directement dans Radarr/Sonarr (sans demande) n'est jamais candidat ;
// - un candidat reste visible tant que personne n'a décidé : le passé se trie à la main, par lot ;
// - l'automatique ne masque que les demandes faites *après* qu'on l'a allumé ;
// - une décision à la main l'emporte toujours : un titre rendu visible ne se re-masque pas tout seul ;
// - un masquage automatique tombe si un compte gardé demande ensuite le même titre.

import type { RequestHideRow } from "@/lib/db";

export type TitleKind = "movie" | "series";

/** Une demande Jellyseerr, réduite à ce que la règle lit. */
export interface HideRequest {
  key: string;
  createdAt: number;
  requester: string;
  kept: boolean;
}

/** Un titre de la bibliothèque Jellyfin. */
export interface LibraryTitle {
  key: string;
  jfId: string;
  kind: TitleKind;
  name: string;
  year: number | null;
  imageTag: string | null;
  /** Le titre porte déjà le tag dans Jellyfin. */
  tagged: boolean;
}

export interface RequestSummary {
  requesters: string[];
  kept: boolean;
  lastAt: number;
}

/** La forme commune d'un titre : `movie:<tmdb>`, `series:<tmdb>` ; une série sans TMDB garde son TVDB. */
export function titleKey(kind: TitleKind, tmdb: string | number | null | undefined, tvdb?: string | number | null): string | null {
  const t = tmdb === null || tmdb === undefined ? "" : String(tmdb).trim();
  if (t && t !== "0") return `${kind}:${t}`;
  const v = tvdb === null || tvdb === undefined ? "" : String(tvdb).trim();
  if (kind === "series" && v && v !== "0") return `series-tvdb:${v}`;
  return null;
}

/** Les noms d'une liste « a, b, c », en minuscules. */
export function nameSet(raw: string): Set<string> {
  return new Set(
    raw
      .split(/[,\n]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Par titre : qui l'a demandé, et si un compte gardé en fait partie. */
export function summarize(requests: readonly HideRequest[]): Map<string, RequestSummary> {
  const out = new Map<string, RequestSummary>();
  for (const r of requests) {
    const cur = out.get(r.key) ?? { requesters: [], kept: false, lastAt: 0 };
    if (!cur.requesters.includes(r.requester)) cur.requesters.push(r.requester);
    cur.kept ||= r.kept;
    cur.lastAt = Math.max(cur.lastAt, r.createdAt);
    out.set(r.key, cur);
  }
  return out;
}

export function isCandidate(summary: RequestSummary | undefined): boolean {
  return !!summary && summary.requesters.length > 0 && !summary.kept;
}

/**
 * Ce que l'automatique change : les candidats demandés depuis `autoSince` et que personne n'a encore
 * décidés sont masqués ; un masquage automatique dont le titre a depuis été demandé par un compte
 * gardé est retiré. `autoSince` nul : automatique coupé, rien n'est ajouté (les retraits valent quand
 * même — la règle du compte gardé ne dépend pas de l'interrupteur).
 */
export function autoChanges(
  summaries: ReadonlyMap<string, RequestSummary>,
  rows: readonly RequestHideRow[],
  autoSince: number | null,
): { hide: string[]; drop: string[] } {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const hide: string[] = [];
  const drop: string[] = [];
  for (const [key, s] of summaries) {
    const row = byKey.get(key);
    if (row) {
      if (row.source === "auto" && s.kept) drop.push(key);
      continue;
    }
    if (autoSince !== null && isCandidate(s) && s.lastAt >= autoSince) hide.push(key);
  }
  return { hide, drop };
}

export function hiddenKeys(rows: readonly RequestHideRow[]): Set<string> {
  return new Set(rows.filter((r) => r.state === "hidden").map((r) => r.key));
}

export type ViewStatus = "candidate" | "hidden" | "shown" | "kept" | "free";

export interface ViewItem {
  key: string;
  jfId: string;
  kind: TitleKind;
  name: string;
  year: number | null;
  imageTag: string | null;
  requesters: string[];
  status: ViewStatus;
  source: RequestHideRow["source"] | null;
  /** Jellyfin dit déjà ce que la décision veut (tag posé si masqué, absent sinon). */
  applied: boolean;
  requestedAt: number | null;
}

/**
 * L'écran : chaque titre de la bibliothèque avec son état. Une décision prend le pas sur la règle ;
 * sans décision, un titre demandé par un compte gardé est « gardé », un candidat « à trier », et un
 * titre jamais demandé « libre ».
 */
export function buildView(
  library: readonly LibraryTitle[],
  summaries: ReadonlyMap<string, RequestSummary>,
  rows: readonly RequestHideRow[],
): ViewItem[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return library.map((t) => {
    const s = summaries.get(t.key);
    const row = byKey.get(t.key);
    const status: ViewStatus = row ? row.state : s?.kept ? "kept" : isCandidate(s) ? "candidate" : "free";
    return {
      key: t.key,
      jfId: t.jfId,
      kind: t.kind,
      name: t.name,
      year: t.year,
      imageTag: t.imageTag,
      requesters: s?.requesters ?? [],
      status,
      source: row?.source ?? null,
      applied: t.tagged === (status === "hidden"),
      requestedAt: s?.lastAt ?? null,
    };
  });
}

/** Les tags d'un titre avec ou sans le nôtre — `null` s'il n'y a rien à changer (casse ignorée, comme Jellyfin). */
export function retag(tags: readonly string[] | null | undefined, tag: string, want: boolean): string[] | null {
  const current = (tags ?? []).filter((t): t is string => typeof t === "string");
  const has = current.some((t) => t.toLowerCase() === tag.toLowerCase());
  if (has === want) return null;
  return want ? [...current, tag] : current.filter((t) => t.toLowerCase() !== tag.toLowerCase());
}
