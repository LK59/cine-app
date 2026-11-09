import { HttpError } from "@/lib/http";
import { xray, type XrayItemState, type XrayJob, type XrayPriority } from "@/lib/clients/xray";
import { castOf, castWithPhotos, type AnalysisTarget, originalLanguageOf } from "./cast";
import { sameDuration } from "./scanPlan";
import { recordedDuration, recordFileVersion } from "./scanStore";

/**
 * Un fichier remplacé **à durée égale** garde son analyse (consigne du propriétaire, 09/11/2026 ;
 * DECISIONS.md §138). Les 65 épisodes de *MacGyver* réencodés d'AV1 en HEVC ce jour-là ont changé
 * d'`ETag` et pas d'une image : leurs scènes tombent toujours juste, et les réanalyser coûtait des
 * heures de calcul pour le même résultat.
 *
 * La durée de la version analysée : celle que le service a lue (`durationS` de `/items`, ffprobe) ;
 * sinon celle que Laterna a retenue en la commandant (`xray_file_versions`) ; sinon la fin d'un résultat
 * complet — `analyzedUntil` y est la durée du fichier lu (`xray/app/results.py`). Comparée à la durée
 * que Jellyfin donne du fichier présent, à une seconde près. Le service refait la même comparaison de
 * son côté avant de rattacher (`rebindIfSameDuration`, xray/README.md).
 */

/** Ce qu'il faut d'un état du service ; `durationS` (la durée lue par ffprobe) depuis le 09/11/2026. */
export type AnalysedState = Pick<XrayItemState, "etag" | "status" | "analyzedUntil"> & { durationS?: number | null };

/**
 * La durée de la version qu'a analysée le service, ou `null` si on ne la connaît pas : celle que le
 * service a lue (`durationS` de `/items`), sinon celle que Laterna a retenue en commandant, sinon la fin
 * d'un résultat complet.
 */
export function analysedDuration(itemId: string, state: AnalysedState, complete = state.status === "done"): number | null {
  if (typeof state.durationS === "number" && state.durationS > 0) return state.durationS;
  const recorded = state.etag ? safe(() => recordedDuration(itemId, state.etag)) : null;
  if (recorded) return recorded;
  return complete && typeof state.analyzedUntil === "number" && state.analyzedUntil > 0 ? state.analyzedUntil : null;
}

/** L'analyse d'un autre `ETag` vaut-elle pour le fichier présent ? Oui à durée égale (± 1 s). */
export function keepsAnalysis(itemId: string, state: AnalysedState, currentDurationS: number | null | undefined, complete?: boolean): boolean {
  return sameDuration(analysedDuration(itemId, state, complete), currentDurationS);
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

export type RebindableJob = XrayJob & { rebindIfSameDuration?: true; durationS?: number };

/** La commande d'un élément : distribution de TMDB et photos. `null` sans distribution. */
export async function jobFor(target: AnalysisTarget, priority: XrayPriority, startAt?: number): Promise<{ job: XrayJob; cast: number } | null> {
  const cast = target.tmdb ? await castOf(target.tmdb) : [];
  if (cast.length === 0) return null;
  return {
    job: {
      itemId: target.itemId,
      path: target.path,
      etag: target.etag,
      priority,
      ...(startAt && startAt > 0 ? { startAt: Math.round(startAt * 1000) / 1000 } : {}),
      seriesId: target.seriesId,
      cast: await castWithPhotos(cast),
      originalLanguage: originalLanguageOf(target.tmdb),
    },
    cast: cast.length,
  };
}

export type RebindOutcome = "rebound" | "refused" | "queued";

/**
 * Demande au service de rattacher son analyse au nouvel `ETag` : la commande ordinaire, avec
 * `rebindIfSameDuration: true` et la durée, **à la priorité de la commande** (`priority`, par défaut
 * celle du `job`). Un 200 `done` : rattachée. Un 202 : le service n'a pas rattaché (durée qu'il trouve
 * différente, résultat incomplet, ou version qui ignore le champ) — selon le contrat (xray/README.md,
 * `POST /jobs`), un autre `etag` lui fait alors **oublier l'ancien résultat et réanalyser** : l'élément
 * est en file, à cette priorité. Jusqu'au 09/11/2026 la priorité était forcée à `low` ici : une série
 * de la liste de priorité (palier 0, `normal`) ou la commande d'un spectateur (`high`) qui ne se
 * rattachait pas retombait derrière tout le fond. Un 400 (champ invalide, chemin hors de la
 * médiathèque) : rien n'est commandé, l'ancien résultat reste — le lecteur le sert quand même
 * (`scenes.ts`).
 */
export async function rebindAnalysis(job: XrayJob, durationS: number, priority: XrayPriority = job.priority): Promise<RebindOutcome> {
  const body: RebindableJob = { ...job, priority, rebindIfSameDuration: true, durationS };
  try {
    const answer = await xray.enqueue(body);
    if (answer.status === "done") {
      safe(() => recordFileVersion(job.itemId, job.etag, durationS));
      return "rebound";
    }
    safe(() => recordFileVersion(job.itemId, job.etag, durationS));
    return "queued";
  } catch (error) {
    if (error instanceof HttpError && error.status === 400) return "refused";
    throw error;
  }
}
