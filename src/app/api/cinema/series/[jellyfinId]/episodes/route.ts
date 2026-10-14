import { firstEpisodeOf } from "@/lib/nextEpisode";
import { errorBody } from "@/lib/apiErrorCodes";
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { jellyfin } from "@/lib/clients/jellyfin";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { applyAttachedEpisodeText, fillEpisodeText } from "@/lib/episodeFallback";
import { arrangeEpisodes, type ArrangedEpisode } from "@/lib/episodeDisplay";
import { cachedItemProviderIds, cachedSeries, cachedSonarrEpisodeTexts, getProviderIdCI } from "@/lib/server-cache";
import { catalogueLinks } from "@/lib/sonarrLink";
import type { SonarrSeries } from "@/lib/clients/sonarr";
import { localeOf } from "@/lib/i18n";
import { episodeTextTrustDb } from "@/lib/libraryCheck/store";

export interface CinemaEpisode {
  jellyfinItemId: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  overview: string | null;
  thumbnailUrl: string | null;
  runtimeMinutes: number | null;
  // Same duration as runtimeMinutes, unrounded: a progress bar and a "23 min restantes" label
  // both need the real value, and rounding to whole minutes first visibly skews a short episode.
  runtimeTicks: number | null;
  watched: boolean;
  resumeTicks: number | null;
}

export interface CinemaSeason {
  seasonNumber: number;
  episodes: CinemaEpisode[];
}

export interface CinemaEpisodesPayload {
  seasons: CinemaSeason[];
  nextEpisode: {
    itemId: string;
    title: string;
    resumeTicks?: number;
    runtimeTicks?: number;
    seasonNumber: number;
    episodeNumber: number;
    /** Tout a été vu : c'est un revisionnage depuis le premier épisode — « Lire », pas « À suivre ». */
    rewatch?: boolean;
  } | null;
}

function toCinemaEpisode(arranged: ArrangedEpisode): CinemaEpisode & { path: string | null } {
  const { item } = arranged;
  return {
    jellyfinItemId: item.Id,
    // Le rangement est celui du disque (Jellyfin) ; un épisode sans numéro prend celui de son fichier,
    // sinon la fin de sa saison, et un titre qui n'est que le nom du fichier devient « Épisode N »
    // (`arrangeEpisodes`, DECISIONS.md §89).
    seasonNumber: arranged.seasonNumber,
    episodeNumber: arranged.episodeNumber,
    title: arranged.title,
    overview: item.Overview ?? null,
    thumbnailUrl: item.ImageTags?.Primary ? `/api/jellyfin/image?itemId=${item.Id}&tag=${item.ImageTags.Primary}` : null,
    // Une minute au moins : un bonus de moins de trente secondes arrondissait à 0, et les listes
    // d'épisodes (`runtimeMinutes && …`) affichaient alors un « 0 » nu à côté du titre.
    runtimeMinutes: item.RunTimeTicks ? Math.max(1, Math.round(item.RunTimeTicks / 10_000_000 / 60)) : null,
    runtimeTicks: item.RunTimeTicks ?? null,
    watched: item.UserData?.Played ?? false,
    resumeTicks: item.UserData?.PlaybackPositionTicks ?? null,
    // Le pont avec Sonarr (le même fichier), retiré avant la réponse.
    path: item.Path ?? null,
  };
}

/**
 * Le titre du catalogue derrière cette série, et ce qu'il faut pour en écrire les épisodes : le TMDB
 * **du catalogue** (Sonarr, ou Jellyfin pour une série qu'il a seule) — plus celui que Jellyfin a
 * posé, qui peut être celui d'une autre série — et, pour une série Sonarr, les épisodes qu'il a
 * rattachés à leurs fichiers (DECISIONS.md §89). Jellyfin ou Sonarr muets : ce que Jellyfin sait seul.
 */
async function seriesIdentity(jellyfinId: string, jellyfinProviderIds: Record<string, string> | undefined) {
  const jellyfinTmdb = getProviderIdCI(jellyfinProviderIds, "tmdb");
  const fallback = { tmdbId: jellyfinTmdb ? Number.parseInt(jellyfinTmdb, 10) : null, sonarr: null as SonarrSeries | null, jellyfinText: false };
  const link = (await catalogueLinks()).get(jellyfinId);
  if (!link) return fallback;
  if (link.source !== "sonarr") return { tmdbId: link.tmdbId, sonarr: null, jellyfinText: true };
  // L'exception par série (§89, posée depuis le contrôle de la bibliothèque, §90) : l'administrateur a
  // décidé que Jellyfin a les bons noms d'épisodes. L'identité reste celle de Sonarr ; le texte, celui
  // de Jellyfin, verrouillages compris — ni l'épisode rattaché par Sonarr, ni TMDB.
  if (episodeTextTrustDb.has(link.catalogueId)) return { tmdbId: link.tmdbId, sonarr: null, jellyfinText: true };
  const sonarrSeries = (await cachedSeries().catch(() => [] as SonarrSeries[])).find((s) => s.id === link.catalogueId) ?? null;
  return { tmdbId: link.tmdbId, sonarr: sonarrSeries, jellyfinText: false };
}

/** Jellyfin identifie-t-il la série comme Sonarr ? Un identifiant commun suffit. */
function jellyfinAgreesWith(sonarrSeries: SonarrSeries, ids: Record<string, string> | undefined): boolean {
  const tvdb = getProviderIdCI(ids, "tvdb");
  const tmdb = getProviderIdCI(ids, "tmdb");
  return (!!tvdb && Number(tvdb) === sonarrSeries.tvdbId) || (!!tmdb && !!sonarrSeries.tmdbId && Number(tmdb) === sonarrSeries.tmdbId);
}

// Takes the series' JELLYFIN item id directly (already known from the /api/cinema/series bulk
// payload) rather than a Sonarr id — Jellyfin's own episode list already carries everything
// this needs (title, overview, thumbnail, runtime, watched state, itemId to actually play), so
// there's no need to also fetch Sonarr's episode list and cross-reference by season/episode
// number the way the standard (non-Cinema) series detail page does; every episode Jellyfin
// returns here is by definition already downloaded and playable.
export async function GET(req: NextRequest, props: { params: Promise<{ jellyfinId: string }> }) {
  const { jellyfinId } = await props.params;
  // Interpolé tel quel dans `/Shows/{id}/Episodes` par le client, avec la clé d'administration :
  // un `?` tronquerait le chemin et laisserait réécrire la query string.
  if (!isJellyfinId(jellyfinId)) return NextResponse.json(errorBody("Identifiant invalide", "invalid_request"), { status: 400 });
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  if (!session?.jfId) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const [items, nextUp, series] = await Promise.all([
    jellyfin.getSeriesEpisodes(session.jfId, jellyfinId).catch(() => []),
    jellyfin.getNextUp(session.jfId, jellyfinId).catch(() => null),
    cachedItemProviderIds(session.jfId, jellyfinId).catch(() => null),
  ]);

  const locale = localeOf(req);
  const providerIds = series?.ProviderIds as Record<string, string> | undefined;
  const identity = await seriesIdentity(jellyfinId, providerIds).catch(() => ({ tmdbId: null, sonarr: null, jellyfinText: false }));
  const seriesName = items.find((item) => item.SeriesName)?.SeriesName ?? null;
  const episodes = arrangeEpisodes(items, seriesName, locale).map(toCinemaEpisode);

  // Noms et résumés selon la règle de vérité (§89) : l'épisode que Sonarr a rattaché au fichier,
  // puis — pour les autres — ce que Jellyfin a, complété par TMDB au TMDB du catalogue, dans la
  // langue de qui regarde puis en anglais (`fillEpisodeText`). Jamais bloquant pour le reste.
  let settled = new Set<(typeof episodes)[number]>();
  if (identity.sonarr) {
    const attached = await cachedSonarrEpisodeTexts(identity.sonarr.id).catch(() => []);
    settled = await applyAttachedEpisodeText(episodes, attached, identity.sonarr.tmdbId, jellyfinAgreesWith(identity.sonarr, providerIds), locale).catch(
      () => new Set<(typeof episodes)[number]>()
    );
  }
  // Une série que Jellyfin a seule (§89), ou que l'administrateur lui a confiée (§90) : son texte, jamais
  // complété par TMDB. Ses saisons sont celles du disque, que TMDB peut numéroter autrement — *La Casa
  // de Papel* rangée comme Netflix (5 parties) recevait, en saison 2, les titres de la saison 2 de TMDB,
  // qui sont ceux de la partie 3 (14/10/2026).
  if (!identity.jellyfinText) {
    await fillEpisodeText(episodes.filter((e) => !settled.has(e)), identity.tmdbId, locale).catch(() => {});
  }

  const bySeasonNumber = new Map<number, CinemaEpisode[]>();
  for (const { path: _path, ...ep } of episodes) {
    (bySeasonNumber.get(ep.seasonNumber) ?? bySeasonNumber.set(ep.seasonNumber, []).get(ep.seasonNumber)!).push(ep);
  }
  for (const list of bySeasonNumber.values()) list.sort((a, b) => a.episodeNumber - b.episodeNumber);

  // Season 0 (specials) sorts last, like Netflix/Jellyfin's own season pickers, not first —
  // everything else ascending.
  const seasons: CinemaSeason[] = [...bySeasonNumber.entries()]
    .sort(([a], [b]) => (a === 0 ? 1 : b === 0 ? -1 : a - b))
    .map(([seasonNumber, episodes]) => ({ seasonNumber, episodes }));

  // Rien « à suivre » et tout vu : on repart du premier épisode — voir `firstEpisodeOf`. Seulement
  // si tout est vu : un « à suivre » absent parce que Jellyfin n'a pas répondu ne doit pas
  // renvoyer au début quelqu'un qui en est à la saison 3.
  const regular = seasons.filter((s) => s.seasonNumber !== 0).flatMap((s) => s.episodes);
  const allWatched = regular.length > 0 && regular.every((episode) => episode.watched);
  const first = !nextUp && allWatched ? firstEpisodeOf(seasons) : null;

  // « À suivre » sous le même titre et le même numéro que dans la liste juste en dessous.
  const listed = nextUp ? episodes.find((e) => e.jellyfinItemId === nextUp.Id) : undefined;
  const payload: CinemaEpisodesPayload = {
    seasons,
    nextEpisode: nextUp
      ? {
          itemId: nextUp.Id,
          title: listed?.title ?? nextUp.Name,
          resumeTicks: nextUp.UserData?.PlaybackPositionTicks,
          runtimeTicks: nextUp.RunTimeTicks,
          seasonNumber: listed?.seasonNumber ?? nextUp.ParentIndexNumber ?? 0,
          episodeNumber: listed?.episodeNumber ?? nextUp.IndexNumber ?? 0,
        }
      : first
        ? {
            itemId: first.jellyfinItemId,
            title: first.title,
            // Depuis le début : marquer « vu » a effacé la position, et c'est un revisionnage.
            resumeTicks: 0,
            runtimeTicks: first.runtimeTicks ?? undefined,
            seasonNumber: first.seasonNumber,
            episodeNumber: first.episodeNumber,
            rewatch: true,
          }
        : null,
  };
  return NextResponse.json(payload);
}
