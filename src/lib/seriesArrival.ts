// Quand une série est-elle « arrivée » — et qu'est-ce qui est arrivé (DECISIONS.md §74).
//
// Jusqu'au 12/10/2026, une série datait de son ajout dans Sonarr, et rien d'autre : *Ted Lasso*,
// ajoutée en avril, ne remontait jamais dans « Récemment ajoutés » quand sa saison 4 arrivait épisode
// par épisode, alors que Jellyfin, lui, la remontait. La date d'une série est désormais celle de ce
// qu'on peut y regarder de plus récent — max(son ajout à elle, l'entrée du dernier épisode dans la
// bibliothèque) —, et la pastille dit pourquoi elle est là : nouvelle série, nouvelle saison, nouvel
// épisode.
//
// Tout ce qui parle de « récent » pour une série lit le `addedAt` qui en sort — la rangée, la
// bannière des nouveautés, la pastille, le tri « récents » de la grille, le départage du top 10 — si
// bien qu'aucune de ces vues n'a sa propre idée de la chose.

import { NEW_BADGE_DAYS, type SeriesArrival } from "@/lib/cinemaRails";

export type { SeriesArrival };

/** Un épisode entré récemment dans la bibliothèque, réduit à ce que la décision lit. */
export interface RecentEpisode {
  id: string;
  seriesId: string;
  season: number | null;
  episode: number | null;
  /** `DateCreated` de Jellyfin : l'instant où l'épisode est devenu jouable. */
  createdAt: string;
}

/** Le dernier ajout d'une série : son épisode le plus récent, et s'il ouvre une saison. */
export interface LatestArrival {
  episodeId: string;
  at: string;
  opensSeason: boolean;
}

const DAY_MS = 86_400_000;

/**
 * Ce qui compte comme un même ajout. Une saison entière s'importe en quelques minutes à une heure
 * (mesuré le 12/10/2026 : *Les Anneaux de pouvoir*, seize épisodes entre 18 h 30 et 18 h 57) ; un
 * épisode hebdomadaire arrive seul, une semaine après le précédent. Un jour sépare les deux sans
 * ambiguïté.
 */
export const ARRIVAL_BATCH_MS = DAY_MS;

function timeOf(iso: string | null | undefined): number | null {
  // `0001-01-01` : le « jamais » de Sonarr — voir `addedTime` dans cinemaRails.
  if (!iso || iso.startsWith("0001-01-01")) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Le dernier ajout de chaque série (clé : identifiant Jellyfin de la série), tiré des épisodes
 * récents de toute la bibliothèque — une liste, pas une requête par série.
 *
 * Il « ouvre une saison » quand le lot qui le contient (les épisodes de la série entrés dans le jour
 * qui précède) porte une saison au-delà de la première dont on n'avait encore rien — son épisode 1,
 * ou plusieurs de ses épisodes sans qu'aucun ne soit entré avant le lot. La saison 1 n'en ouvre
 * jamais : elle ouvre une série, ce que dit la date de la série elle-même. Les spéciaux (saison 0)
 * non plus.
 */
export function latestArrivals(episodes: readonly RecentEpisode[]): Map<string, LatestArrival> {
  const bySeries = new Map<string, (RecentEpisode & { t: number })[]>();
  for (const ep of episodes) {
    const t = timeOf(ep.createdAt);
    if (t === null || !ep.seriesId) continue;
    const list = bySeries.get(ep.seriesId) ?? [];
    list.push({ ...ep, t });
    bySeries.set(ep.seriesId, list);
  }
  const out = new Map<string, LatestArrival>();
  for (const [seriesId, list] of bySeries) {
    let latest = list[0];
    for (const ep of list) if (ep.t > latest.t) latest = ep;
    const batchStart = latest.t - ARRIVAL_BATCH_MS;
    const batch = list.filter((ep) => ep.t >= batchStart);
    const before = list.filter((ep) => ep.t < batchStart);
    const opensSeason = [...new Set(batch.map((ep) => ep.season))].some((season) => {
      if (season === null || season <= 1) return false;
      const inBatch = batch.filter((ep) => ep.season === season);
      if (inBatch.some((ep) => ep.episode === 1)) return true;
      return inBatch.length > 1 && !before.some((ep) => ep.season === season);
    });
    out.set(seriesId, { episodeId: latest.id, at: latest.createdAt, opensSeason });
  }
  return out;
}

export interface SeriesFreshnessInput {
  /** L'ajout de la série dans Sonarr. */
  sonarrAddedAt: string | null;
  /** L'entrée de la série dans Jellyfin — plus tard que Sonarr quand ses premiers fichiers ont tardé. */
  libraryAddedAt: string | null | undefined;
  latest: LatestArrival | undefined;
  /** Ce compte a-t-il déjà vu l'épisode le plus récent ? */
  seenLatest: boolean;
  now?: number;
}

/**
 * La date d'une série pour ce compte, et ce qu'elle désigne — la seule décision, que la route du
 * catalogue prend et que toutes les vues (bureau, téléphone, rangées, pastilles) se contentent de lire.
 *
 * - **La série** est récente (Sonarr ou Jellyfin dans la fenêtre de la pastille) : « Nouvelle série »,
 *   quoi qu'il soit arrivé depuis — elle reste nouvelle tout son premier mois.
 * - Sinon, **un épisode** entré dans la fenêtre et que ce compte n'a pas vu la date, et dit
 *   « Nouvelle saison » s'il en ouvre une, « Nouvel épisode » sinon. Une série jamais commencée remonte
 *   aussi : elle n'a pas vu cet épisode (choix de Louis, 12/10/2026).
 * - **Déjà vu**, ou arrivé hors de la fenêtre : la série garde sa propre date, comme avant.
 *
 * `arrival` est absent quand la date n'est pas récente : il n'y a rien à dire.
 */
export function seriesFreshness({ sonarrAddedAt, libraryAddedAt, latest, seenLatest, now = Date.now() }: SeriesFreshnessInput): {
  addedAt: string | null;
  arrival?: SeriesArrival;
} {
  const windowStart = now - NEW_BADGE_DAYS * DAY_MS;
  const sonarrT = timeOf(sonarrAddedAt);
  const libraryT = timeOf(libraryAddedAt);
  // La date propre de la série : la plus tardive des deux — une série demandée il y a un an dont
  // les premiers épisodes arrivent aujourd'hui est une série nouvelle, pas un nouvel épisode.
  const own = libraryT !== null && (sonarrT === null || libraryT > sonarrT) ? libraryAddedAt! : sonarrT !== null ? sonarrAddedAt : null;
  const ownT = timeOf(own);
  const latestT = latest ? timeOf(latest.at) : null;
  const episodeCounts = latest !== undefined && latestT !== null && !seenLatest && latestT >= windowStart && (ownT === null || latestT > ownT);

  if (ownT !== null && ownT >= windowStart) {
    return { addedAt: episodeCounts ? latest!.at : own, arrival: "series" };
  }
  if (episodeCounts) return { addedAt: latest!.at, arrival: latest!.opensSeason ? "season" : "episode" };
  return { addedAt: own };
}
