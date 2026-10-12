import type { JellyfinMediaSource, JellyfinMediaStream } from "@/lib/clients/jellyfin";
import { isOurStream } from "./present";
import { jobsDb, sameFile } from "./store";

/** L'adresse du WebVTT final d'une tâche, servi depuis `data/subtitles`. */
export function fileUrlOf(jobId: string): string {
  return `/api/subtitle-gen/files/${jobId}.vtt`;
}

/**
 * Ce que la route `direct` ajoute aux sous-titres externes (DECISIONS.md §69, contrat du lecteur) :
 * - un externe que Jellyfin liste et qui est **le nôtre** porte `generated: true` ;
 * - tant que Jellyfin ne le présente pas, rien n'est ajouté — le lecteur garde son entrée
 *   « … génération… » alimentée par `/poll` ;
 * - si l'envoi à Jellyfin a échoué pour de bon, la copie de `data/` est servie à la place.
 * Ne lève jamais : la description du fichier ne doit pas tomber pour un ornement.
 */
export function generatedForDirect(
  itemId: string,
  source: Pick<JellyfinMediaSource, "Id" | "ETag" | "Size" | "Path">,
  streams: JellyfinMediaStream[]
): { ours: Set<number>; fallbacks: { language: string; url: string }[] } {
  const ours = new Set<number>();
  const fallbacks: { language: string; url: string }[] = [];
  try {
    for (const job of jobsDb.forItem(itemId)) {
      if (job.status !== "done" || job.media_source_id !== source.Id) continue;
      if (!sameFile(job, { etag: source.ETag ?? null, size: typeof source.Size === "number" ? source.Size : null })) continue;
      if (job.present_state === "failed") {
        fallbacks.push({ language: job.target, url: fileUrlOf(job.id) });
        continue;
      }
      if (job.present_state !== "presented" && job.present_state !== "uploaded") continue;
      const facts = {
        videoPath: job.video_path ?? source.Path ?? null,
        target: job.target,
        prePaths: JSON.parse(job.present_pre_paths ?? "[]") as string[],
        knownPath: job.present_state === "presented" ? job.present_path : null,
      };
      for (const s of streams) if (isOurStream(s, facts)) ours.add(s.Index);
    }
  } catch {
    /* une base illisible ne retire rien à la description */
  }
  return { ours, fallbacks };
}
