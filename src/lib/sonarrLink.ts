import { cachedSeries, cachedItemProviderIds } from "@/lib/server-cache";

/**
 * De la série vue par Jellyfin à sa fiche dans Sonarr.
 *
 * Les deux flux de reprise en ont besoin — « Reprendre » pour un épisode commencé, « À suivre »
 * pour le prochain — et le calculaient chacun de leur côté, avec les mêmes trois étapes : Jellyfin
 * ne pose jamais d'identifiants externes sur un épisode, seulement sur sa série ; il faut donc les
 * demander série par série, en tirer le TVDB, puis le retrouver dans le catalogue Sonarr.
 *
 * Deux copies d'un même calcul, c'est une correction sur une seule le jour où il se trompe — et
 * c'est précisément ce qui venait d'arriver : la version de « À suivre » interrogeait Sonarr sans
 * passer par le cache, sur un flux que le retour sur l'application relit et que les deux onglets
 * demandent. Une carte de reprise qui n'ouvre pas sa fiche, c'est un bouton mort ; qu'elle
 * l'ouvre coûte maintenant le même prix des deux côtés.
 */
export async function sonarrIdsBySeriesId(
  jfUserId: string,
  seriesIds: string[]
): Promise<Map<string, number>> {
  const unique = [...new Set(seriesIds)];
  const [series, tvdbEntries] = await Promise.all([
    cachedSeries().catch(() => []),
    Promise.all(
      unique.map(async (seriesId) => {
        const providerIds = await cachedItemProviderIds(jfUserId, seriesId).catch(() => null);
        const tvdb = providerIds?.ProviderIds?.Tvdb;
        return [seriesId, tvdb ? parseInt(tvdb, 10) : null] as const;
      })
    ),
  ]);

  const sonarrByTvdb = new Map(series.filter((s) => s.tvdbId).map((s) => [s.tvdbId, s.id] as const));
  const out = new Map<string, number>();
  for (const [seriesId, tvdb] of tvdbEntries) {
    const sonarrId = tvdb !== null ? sonarrByTvdb.get(tvdb) : undefined;
    if (sonarrId !== undefined) out.set(seriesId, sonarrId);
  }
  return out;
}
