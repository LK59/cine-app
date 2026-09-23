import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { jellyfin } from "@/lib/clients/jellyfin";
import { cachedMovies, cachedSeries } from "@/lib/server-cache";
import { sonarrIdsBySeriesId } from "@/lib/sonarrLink";
import { isJellyfinId } from "@/lib/jellyfinPath";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  if (!session?.jfId) {
    return NextResponse.json({ items: [] });
  }

  const [resumeData, movies, series] = await Promise.all([
    jellyfin.getResumeItems(session.jfId).catch(() => ({ Items: [] })),
    cachedMovies().catch(() => []),
    cachedSeries().catch(() => []),
  ]);

  // Seulement les films qui ont un fichier : le catalogue du cinéma ne contient qu'eux. Un film en
  // cours dont Radarr n'a plus le fichier (en pleine mise à niveau, par exemple) menait à une fiche
  // introuvable — l'adresse était effacée, et le clic ne faisait rien (23/09/2026). Sans lien, la
  // carte lance la lecture directement, ce que Jellyfin sait encore faire.
  const moviesByTmdb = new Map(movies.filter((m) => m.hasFile).map((m) => [m.tmdbId, m.id]));
  const seriesByTvdb = new Map(series.map((s) => [s.tvdbId, s.id]));

  // Jellyfin ne pose jamais d'identifiants externes sur un épisode, seulement sur sa série : la
  // fiche d'un épisode en cours se retrouve donc par la série. Même calcul que « À suivre », et
  // au même endroit — voir `sonarrIdsBySeriesId`.
  const sonarrBySeries = await sonarrIdsBySeriesId(
    session.jfId,
    resumeData.Items.filter((i) => i.Type === "Episode" && i.SeriesId).map((i) => i.SeriesId!)
  );

  const items = resumeData.Items.map((item) => {
    const positionTicks = item.UserData?.PlaybackPositionTicks ?? 0;
    const runtimeTicks = item.RunTimeTicks ?? 0;
    const progress = runtimeTicks > 0 ? Math.min((positionTicks / runtimeTicks) * 100, 99) : 0;

    let cinemaHref: string | null = null;
    if (item.Type === "Movie" && item.ProviderIds?.Tmdb) {
      const tmdbId = parseInt(item.ProviderIds.Tmdb, 10);
      const radarrId = moviesByTmdb.get(tmdbId);
      if (radarrId) cinemaHref = `/radarr/${radarrId}`;
    } else if (item.Type === "Series" && item.ProviderIds?.Tvdb) {
      const tvdbId = parseInt(item.ProviderIds.Tvdb, 10);
      const sonarrId = seriesByTvdb.get(tvdbId);
      if (sonarrId) cinemaHref = `/sonarr/${sonarrId}`;
    } else if (item.Type === "Episode" && item.SeriesId) {
      const sonarrId = sonarrBySeries.get(item.SeriesId);
      if (sonarrId) cinemaHref = `/sonarr/${sonarrId}`;
    }

    return {
      id: item.Id,
      name: item.Type === "Episode" && item.SeriesName ? item.SeriesName : item.Name,
      subtitle:
        item.Type === "Episode"
          ? `S${String(item.ParentIndexNumber ?? 1).padStart(2, "0")}E${String(item.IndexNumber ?? 1).padStart(2, "0")} · ${item.Name}`
          : null,
      type: item.Type,
      progress: Math.round(progress),
      // Ticks as well as the percentage: Cinema Mode's Continue Watching cards resume playback
      // from the exact position and label themselves with the time remaining.
      positionTicks,
      runtimeTicks,
      imageTag: item.ImageTags?.Primary ?? null,
      cinemaHref,
    };
  });

  return NextResponse.json({ items });
}

/**
 * Retirer un titre de « Reprendre » : sa position est oubliée, rien d'autre (voir
 * `resetPlaybackPosition`). N'agit que sur le compte de l'appelant — l'identifiant Jellyfin vient
 * de la session, jamais de la requête.
 */
export async function DELETE(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  if (!session?.jfId) {
    return NextResponse.json({ error: "Compte Jellyfin requis" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const itemId = body?.itemId;
  if (!isJellyfinId(itemId)) {
    return NextResponse.json({ error: "Paramètres invalides" }, { status: 400 });
  }
  try {
    await jellyfin.resetPlaybackPosition(session.jfId, itemId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Erreur Jellyfin" }, { status: 502 });
  }
}
