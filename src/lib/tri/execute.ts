// La suppression d'un titre par le tri (DECISIONS.md §198), après la confirmation de l'administrateur.
//
// Dans cet ordre, chaque étape dans sa propre garde (une étape qui échoue est notée et n'empêche pas
// les suivantes, sauf la première vérification) :
//  0. le plan est recalculé et comparé à celui que l'administrateur a vu (`fingerprint`) : s'il a changé
//     — un torrent arrivé, un fichier remplacé —, rien ne part et l'aperçu est à refaire ;
//  1. qBittorrent : chaque torrent du plan, cross-seeds compris, **avec ses fichiers** ;
//  2. Radarr ou Sonarr : le titre et ses fichiers (sans exclusion : il pourra être redemandé) ;
//  3. Jellyseerr : le média, et avec lui toutes ses demandes ;
//  4. Jellyfin : une actualisation de la bibliothèque ;
//  5. les caches de Laterna ;
//  6. l'espace rendu, mesuré au disque (qBittorrent efface en arrière-plan : on attend qu'il bouge).
// Laterna n'efface rien lui-même : le disque des médias est monté en lecture seule ici.
import { dfStatsAsync } from "@/lib/diskUsage";
import { MEDIA_ROOT } from "@/lib/media-paths";
import { qbittorrent } from "@/lib/clients/qbittorrent";
import { radarr } from "@/lib/clients/radarr";
import { sonarr } from "@/lib/clients/sonarr";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { jellyfin } from "@/lib/clients/jellyfin";
import { invalidateByPrefix, invalidateJellyfinLibrary, invalidateLibrary } from "@/lib/server-cache";
import { taskLog } from "@/lib/taskLog";
import { logError } from "@/lib/logger";
import { planRemoval, forgetDiskIndex } from "./plan";
import { forgetTriPayload } from "./collect";
import { recordRemoval } from "./removals";
import type { TriKind, TriRemoval } from "./types";

export class PlanChangedError extends Error {}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Une seule suppression à la fois : deux à la fois mesureraient l'espace l'une de l'autre. */
let busy = false;

export async function executeRemoval(input: {
  kind: TriKind;
  id: number;
  fingerprint: string;
  jellyseerrMediaId: number | null;
  requests: number;
  year: number | null;
  requestedBy: string[];
  sizeBytes: number;
  by: string;
}): Promise<TriRemoval> {
  if (busy) throw new Error("une suppression est déjà en cours");
  busy = true;
  try {
    const plan = await planRemoval(input.kind, input.id, { jellyseerrMediaId: input.jellyseerrMediaId, requests: input.requests }, true);
    if (plan.fingerprint !== input.fingerprint) throw new PlanChangedError("le titre a changé depuis l'aperçu");

    const steps: TriRemoval["steps"] = [];
    const step = async (name: string, fn: () => Promise<string | void>) => {
      try {
        const detail = await fn();
        steps.push({ step: name, ok: true, ...(detail ? { detail } : {}) });
      } catch (e) {
        steps.push({ step: name, ok: false, detail: message(e) });
        logError("tri", e, { step: name, title: plan.title });
      }
    };
    const before = await dfStatsAsync(MEDIA_ROOT);

    if (plan.torrents.length) {
      await step("qbittorrent", async () => {
        await qbittorrent.remove(
          plan.torrents.map((t) => t.hash),
          true
        );
        return `${plan.torrents.length} torrent(s)`;
      });
    }
    await step(input.kind === "movie" ? "radarr" : "sonarr", async () => {
      if (input.kind === "movie") await radarr.deleteMovieWithFiles(input.id);
      else await sonarr.deleteSeriesWithFiles(input.id);
    });
    if (plan.jellyseerrMediaId !== null) {
      const mediaId = plan.jellyseerrMediaId;
      await step("jellyseerr", async () => {
        await jellyseerr.deleteMedia(mediaId);
      });
    }
    await step("jellyfin", async () => {
      await jellyfin.refreshLibrary();
    });
    invalidateLibrary();
    invalidateJellyfinLibrary();
    invalidateByPrefix("jellyseerr:");
    invalidateByPrefix("qbit:");
    forgetDiskIndex();
    forgetTriPayload();

    // L'espace rendu : qBittorrent et Radarr/Sonarr effacent en arrière-plan. On relit le disque jusqu'à
    // ce qu'il ait rendu l'estimation (à 95 %), ou au plus 30 s ; ce qui vient après n'est pas compté.
    let freed: number | null = null;
    if (before.total > 0) {
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const after = await dfStatsAsync(MEDIA_ROOT);
        freed = Math.max(0, before.used - after.used);
        if (freed >= plan.freedBytesEstimate * 0.95) break;
      }
    }

    const entry: TriRemoval = {
      at: new Date().toISOString(),
      kind: input.kind,
      title: plan.title,
      year: input.year,
      requestedBy: input.requestedBy,
      sizeBytes: input.sizeBytes,
      freedBytes: freed,
      torrents: plan.torrents.length,
      steps,
    };
    recordRemoval(entry);
    taskLog("tri", `supprimé « ${plan.title} »`, {
      par: input.by,
      torrents: plan.torrents.length,
      rendu: freed === null ? "?" : `${(freed / 1e9).toFixed(1)} Go`,
      échecs: steps.filter((s) => !s.ok).map((s) => s.step).join(",") || "aucun",
    });
    return entry;
  } finally {
    busy = false;
  }
}
