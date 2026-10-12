import { directInfoKey } from "@/lib/playbackPrefetch";
import type { ExternalSubtitleSource } from "@/lib/webcodecs/externalSubtitles";

/**
 * Le client des routes « Générer des sous-titres » (`/api/subtitle-gen/*`), côté lecteur natif.
 *
 * Écrit contre le contrat de ces routes, et contre lui seul : le moteur qui transcrit et traduit
 * vit sur le serveur, et le lecteur n'en sait que ce que ces quatre adresses répondent. Tout ce qui
 * sort d'ici est typé, et **rien n'y lève sans dire pourquoi** : une génération est un service de
 * plus pendant un film, jamais une raison de l'interrompre — chaque échec devient une
 * `SubtitleGenError` au code nommé, que le lecteur traduit en message passager.
 */

export type JobStatus = "preparing" | "running" | "paused" | "done" | "failed" | "stale";

/** Une génération connue du serveur, telle que `/options` la liste. */
export interface SubtitleGenJob {
  jobId: string;
  /** ISO 639-1. */
  target: string;
  status: JobStatus;
  done: number;
  total: number;
  /** Pourquoi elle est en pause : `budget`, `quota`, `network`, `config`… */
  reason?: string;
  /**
   * Jellyfin présente déjà le fichier fini à côté du film (12/10/2026). Tant que c'est faux, l'entrée
   * temporaire reste dans le menu, nourrie par les lignes du sondage : une génération finie que
   * Jellyfin n'a pas encore relue n'est dans aucune liste, et la retirer laisserait le spectateur
   * sans rien.
   */
  presented: boolean;
}

export interface SubtitleGenOptions {
  enabled: boolean;
  /** ISO 639-1, celle du compte en premier. */
  targets: string[];
  /** Les langues qui ont déjà des sous-titres pour ce titre. */
  existing: string[];
  jobs: SubtitleGenJob[];
  quota: { used: number; limit: number };
}

/** Une ligne traduite. `i` est son rang dans les lignes de la transcription, de 0 à `total` − 1. */
export interface GeneratedCueWire {
  i: number;
  start: number;
  end: number;
  text: string;
}

export interface PollAnswer {
  status: JobStatus;
  reason?: string;
  rev: number;
  done: number;
  total: number;
  /** Les lignes traduites depuis la révision `since` demandée. */
  cues: GeneratedCueWire[];
  fileUrl?: string;
  /** Voir `SubtitleGenJob.presented`. */
  presented: boolean;
}

/**
 * Pourquoi un appel n'a pas abouti — un mot par réponse que le contrat nomme, et deux pour le reste.
 *
 * `quota` (429) : la limite quotidienne de générations ; `budget` (402) : le budget de traduction ;
 * `exists` (409) : une génération existe déjà pour cette langue ; `no-source` (422) : rien à
 * transcrire. `network` : aucune réponse ; `failed` : une autre réponse, ou une réponse illisible.
 */
export type SubtitleGenErrorCode = "quota" | "budget" | "exists" | "no-source" | "network" | "failed";

export class SubtitleGenError extends Error {
  constructor(
    readonly code: SubtitleGenErrorCode,
    readonly status: number | null = null
  ) {
    super(`génération de sous-titres : ${code}${status !== null ? ` (${status})` : ""}`);
    this.name = "SubtitleGenError";
  }
}

const STATUS_CODES: Record<number, SubtitleGenErrorCode> = {
  402: "budget",
  409: "exists",
  422: "no-source",
  429: "quota",
};

async function call<T>(url: string, init: RequestInit | undefined, read: (body: unknown) => T): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (error) {
    // Un abandon voulu reste un abandon : l'appelant le reconnaît et ne dit rien.
    if (init?.signal?.aborted) throw error;
    throw new SubtitleGenError("network");
  }
  if (!res || !res.ok) {
    const status = res?.status ?? null;
    throw new SubtitleGenError((status !== null && STATUS_CODES[status]) || "failed", status);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new SubtitleGenError("failed", res.status);
  }
  try {
    return read(body);
  } catch {
    throw new SubtitleGenError("failed", res.status);
  }
}

const JSON_POST = (body: unknown, signal?: AbortSignal): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
  signal,
});

const isStatus = (value: unknown): value is JobStatus =>
  value === "preparing" || value === "running" || value === "paused" || value === "done" || value === "failed" || value === "stale";

const num = (value: unknown, fallback = 0): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

function readJob(raw: unknown): SubtitleGenJob | null {
  const job = raw as Partial<SubtitleGenJob> | null;
  if (!job || typeof job.jobId !== "string" || typeof job.target !== "string" || !isStatus(job.status)) return null;
  return {
    jobId: job.jobId,
    target: job.target,
    status: job.status,
    done: num(job.done),
    total: num(job.total),
    ...(typeof job.reason === "string" && job.reason ? { reason: job.reason } : {}),
    presented: job.presented === true,
  };
}

/**
 * Ce que le serveur propose pour ce titre. Lu défensivement : une réponse d'une autre forme (une
 * version du serveur qui n'a pas encore ces routes, une page de connexion) donne « rien de proposé »,
 * pas une exception au milieu d'un film.
 */
export function readOptions(body: unknown): SubtitleGenOptions {
  const raw = (body ?? {}) as Partial<Record<keyof SubtitleGenOptions, unknown>>;
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : []);
  const quota = (raw.quota ?? {}) as { used?: unknown; limit?: unknown };
  return {
    enabled: raw.enabled === true,
    targets: strings(raw.targets),
    existing: strings(raw.existing),
    jobs: (Array.isArray(raw.jobs) ? raw.jobs : []).map(readJob).filter((job): job is SubtitleGenJob => job !== null),
    quota: { used: num(quota.used), limit: num(quota.limit) },
  };
}

export function fetchOptions(itemId: string, signal?: AbortSignal): Promise<SubtitleGenOptions> {
  return call(`/api/subtitle-gen/options?itemId=${encodeURIComponent(itemId)}`, { signal }, readOptions);
}

export function createJob(
  request: { itemId: string; mediaSourceId?: string; target: string; position?: number },
  signal?: AbortSignal
): Promise<{ jobId: string; status: JobStatus }> {
  return call("/api/subtitle-gen/jobs", JSON_POST(request, signal), (body) => {
    const answer = body as { jobId?: unknown; status?: unknown };
    if (typeof answer?.jobId !== "string") throw new Error("jobId");
    return { jobId: answer.jobId, status: isStatus(answer.status) ? answer.status : "preparing" };
  });
}

export function pollJob(
  jobId: string,
  request: { since: number; position?: number; sessionId?: string },
  signal?: AbortSignal
): Promise<PollAnswer> {
  return call(`/api/subtitle-gen/jobs/${encodeURIComponent(jobId)}/poll`, JSON_POST(request, signal), (body) => {
    const answer = body as Partial<Record<keyof PollAnswer, unknown>>;
    if (!isStatus(answer?.status)) throw new Error("status");
    const cues = (Array.isArray(answer.cues) ? answer.cues : []).filter(
      (cue): cue is GeneratedCueWire =>
        !!cue &&
        typeof (cue as GeneratedCueWire).i === "number" &&
        Number.isFinite((cue as GeneratedCueWire).start) &&
        Number.isFinite((cue as GeneratedCueWire).end) &&
        typeof (cue as GeneratedCueWire).text === "string"
    );
    return {
      status: answer.status,
      ...(typeof answer.reason === "string" && answer.reason ? { reason: answer.reason } : {}),
      rev: num(answer.rev),
      done: num(answer.done),
      total: num(answer.total),
      cues,
      ...(typeof answer.fileUrl === "string" && answer.fileUrl ? { fileUrl: answer.fileUrl } : {}),
      presented: answer.presented === true,
    };
  });
}

export function resumeJob(jobId: string, signal?: AbortSignal): Promise<void> {
  return call(`/api/subtitle-gen/jobs/${encodeURIComponent(jobId)}/resume`, JSON_POST({}, signal), () => undefined).catch(
    (error: unknown) => {
      // Une réponse sans corps JSON n'est pas un échec de la reprise : seul le statut compte ici.
      if (error instanceof SubtitleGenError && error.code === "failed" && error.status !== null && error.status < 300) return;
      throw error;
    }
  );
}

/**
 * Les fichiers à côté du film, relus **au serveur** — la seule façon de savoir que Jellyfin présente
 * le fichier généré, et sous quel numéro.
 *
 * Un `fetch` nu, ni la clé SWR du lecteur ni la description gardée cinq minutes (`directInfo.ts`) :
 * la première est une dépendance du pipeline, et la changer reconstruirait le lecteur en plein film ;
 * la seconde rendrait la liste d'avant la génération. Seule la liste des externes est lue.
 */
export function fetchExternalSubtitles(itemId: string, signal?: AbortSignal): Promise<ExternalSubtitleSource[]> {
  return call(directInfoKey(itemId), { signal, cache: "no-store" }, (body) => {
    const list = (body as { externalSubtitles?: unknown })?.externalSubtitles;
    if (!Array.isArray(list)) throw new Error("externalSubtitles");
    return list.filter(
      (s): s is ExternalSubtitleSource =>
        !!s && typeof (s as ExternalSubtitleSource).id === "number" && typeof (s as ExternalSubtitleSource).url === "string"
    );
  });
}
