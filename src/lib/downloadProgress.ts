import { radarr } from "@/lib/clients/radarr";
import { sonarr } from "@/lib/clients/sonarr";
import { withCache, TTL, cachedMovies, cachedSeries } from "@/lib/server-cache";

/**
 * « Ça arrive, et où ça en est » — la progression d'un téléchargement, pour le cinéma.
 *
 * La gestion montrait une carte de téléchargement sur ses fiches ; le cinéma n'en disait rien. Le
 * 21/09/2026, Louis a retenu la version discrète : un pourcentage, là où un spectateur attend
 * quelque chose — un titre demandé (fiche découverte), un épisode manquant d'une série. Jamais sur
 * un film de la bibliothèque : le catalogue n'y montre que des films qui ont un fichier, donc un
 * téléchargement n'y serait qu'un remplacement de qualité, et « arrive… » y mentirait.
 *
 * Une seule lecture de la file par service, mise en cache quelques secondes : plusieurs fiches
 * ouvertes l'une après l'autre ne la redemandent pas chacune.
 */

interface QueueRecord {
  movieId?: number;
  seriesId?: number;
  episodeId?: number;
  size?: number;
  sizeleft?: number;
}

/** La part téléchargée, entre 0 et 1 — plusieurs enregistrements s'additionnent (une saison). */
export function queueProgress(records: QueueRecord[]): number | null {
  const total = records.reduce((sum, r) => sum + (r.size ?? 0), 0);
  if (records.length === 0 || total <= 0) return records.length > 0 ? 0 : null;
  const left = records.reduce((sum, r) => sum + Math.max(0, r.sizeleft ?? 0), 0);
  return Math.min(1, Math.max(0, (total - left) / total));
}

export const radarrQueue = () =>
  withCache("radarr:queue", TTL.VERY_SHORT, () => radarr.getQueue()).then((q) => (q.records ?? []) as QueueRecord[]);
export const sonarrQueue = () =>
  withCache("sonarr:queue", TTL.VERY_SHORT, () => sonarr.getQueue()).then((q) => (q.records ?? []) as QueueRecord[]);

/**
 * La progression d'un titre qui n'est pas encore là, par son identifiant TMDB — ou `null` s'il
 * n'est pas en cours de téléchargement. Ne lève pas : ne pas savoir n'empêche pas la fiche.
 */
export async function titleDownloadProgress(type: "movie" | "series", tmdbId: number): Promise<number | null> {
  try {
    if (type === "movie") {
      const movie = (await cachedMovies()).find((m) => m.tmdbId === tmdbId);
      if (!movie) return null;
      return queueProgress((await radarrQueue()).filter((r) => r.movieId === movie.id));
    }
    const show = (await cachedSeries()).find((s) => s.tmdbId === tmdbId);
    if (!show) return null;
    return queueProgress((await sonarrQueue()).filter((r) => r.seriesId === show.id));
  } catch {
    return null;
  }
}
