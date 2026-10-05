import { jellyseerr, type JellyseerrRequest } from "@/lib/clients/jellyseerr";
import { radarr } from "@/lib/clients/radarr";
import { sonarr } from "@/lib/clients/sonarr";
import { invalidateLibrary } from "@/lib/server-cache";
import { logError } from "@/lib/logger";

/**
 * Annuler une demande — la règle décidée le 05/10/2026 (DECISIONS.md §49).
 *
 * Chacun peut retirer **sa** demande, quel que soit son état. Jellyseerr ne laisse un compte
 * ordinaire retirer que ses demandes *en attente* ; avec l'approbation automatique, il n'y en a
 * jamais, et la croix échouait sur toutes (trois refus le 05/10). La propriété est donc vérifiée
 * ici, et le retrait fait avec la clé d'API.
 *
 * - **Restée sans suite** — rien sur le disque, rien en téléchargement (souvent : pas de version
 *   disponible à ce moment-là) : le titre est aussi retiré de Radarr ou Sonarr, sans toucher à
 *   aucun fichier, et Jellyseerr l'oublie — il pourra être redemandé plus tard.
 * - **En cours ou déjà là** : seule la demande disparaît ; Radarr, Sonarr et le téléchargement
 *   restent tels quels.
 *
 * Le titre n'est retiré de Radarr ou Sonarr que s'il n'appartient qu'à cette demande : personne
 * d'autre ne l'a demandé, et il a été ajouté *par* elle (pas avant, à la main, par
 * l'administrateur). Sinon, une annulation le retirerait à quelqu'un qui l'attend aussi.
 */

/** Ajouté par cette demande : au plus tôt une minute avant qu'elle ne soit faite. */
const ADDED_BY_REQUEST_SLACK_MS = 60_000;

export type CancelOutcome = { ok: true; removedFromLibrary: boolean } | { ok: false; status: 404 };

function addedByRequest(added: string | undefined, request: JellyseerrRequest): boolean {
  const addedAt = Date.parse(added ?? "");
  const requestedAt = Date.parse(request.createdAt);
  return Number.isFinite(addedAt) && Number.isFinite(requestedAt) && addedAt >= requestedAt - ADDED_BY_REQUEST_SLACK_MS;
}

/**
 * Ce qu'il faut retirer de Radarr ou Sonarr avec la demande, ou `null` : rien, parce que le titre
 * a un fichier, se télécharge, est demandé par quelqu'un d'autre ou existait avant la demande.
 */
async function libraryEntryToRemove(request: JellyseerrRequest): Promise<{ service: "radarr" | "sonarr"; id: number; mediaId: number } | null> {
  const serviceId = request.media.externalServiceId;
  const tmdbId = request.media.tmdbId;
  const mediaId = request.media.id;
  if (!serviceId || !tmdbId || !mediaId) return null;
  const movie = request.type === "movie";

  const media = movie ? await jellyseerr.getMovieMedia(tmdbId) : await jellyseerr.getTvMedia(tmdbId);
  const others = (media.mediaInfo?.requests ?? []).filter((r) => r.id !== request.id);
  if (others.length > 0) return null;

  if (movie) {
    const [entry, queue] = await Promise.all([radarr.getMovie(serviceId), radarr.getQueue()]);
    if (entry.hasFile || !addedByRequest(entry.added, request)) return null;
    if (queue.records.some((q) => q.movieId === serviceId)) return null;
    return { service: "radarr", id: serviceId, mediaId };
  }
  const [entry, queue] = await Promise.all([sonarr.getSeriesById(serviceId), sonarr.getQueue()]);
  if ((entry.statistics?.episodeFileCount ?? 0) > 0 || !addedByRequest(entry.added, request)) return null;
  if (queue.records.some((q) => q.seriesId === serviceId)) return null;
  return { service: "sonarr", id: serviceId, mediaId };
}

/**
 * Annule la demande `requestId` pour `userId` (son identifiant Jellyseerr). L'administrateur peut
 * retirer n'importe laquelle, avec la même règle pour Radarr et Sonarr.
 */
export async function cancelRequest(requestId: number, caller: { userId: number | null; admin: boolean }): Promise<CancelOutcome> {
  const request = await jellyseerr.getRequest(requestId).catch(() => null);
  if (!request) return { ok: false, status: 404 };
  if (!caller.admin && (caller.userId == null || request.requestedBy?.id !== caller.userId)) return { ok: false, status: 404 };

  // Décidé avant de retirer la demande : après, Jellyseerr ne la compte plus parmi celles du titre.
  // Une vérification qui échoue ne coûte que le ménage dans Radarr/Sonarr, jamais l'annulation.
  let entry: Awaited<ReturnType<typeof libraryEntryToRemove>> = null;
  try {
    entry = await libraryEntryToRemove(request);
  } catch (error) {
    logError("request-cancel-check", error, { requestId });
  }

  await jellyseerr.deleteRequest(requestId);
  if (!entry) return { ok: true, removedFromLibrary: false };

  try {
    if (entry.service === "radarr") await radarr.deleteMovie(entry.id);
    else await sonarr.deleteSeries(entry.id);
    // Et Jellyseerr l'oublie : sinon le titre resterait « en traitement » chez lui, sans
    // personne pour le traiter, et ne pourrait plus être redemandé.
    await jellyseerr.deleteMedia(entry.mediaId).catch((error) => logError("request-cancel-media", error, { requestId }));
    invalidateLibrary();
    return { ok: true, removedFromLibrary: true };
  } catch (error) {
    // La demande est déjà retirée : c'est ce qu'a demandé la personne. Le reste est à faire à la main.
    logError("request-cancel-library", error, { requestId, service: entry.service, id: entry.id });
    return { ok: true, removedFromLibrary: false };
  }
}
