import { config } from "@/lib/config";
import { taskError, taskLog } from "@/lib/taskLog";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { jellyfinIdSegment } from "@/lib/jellyfinPath";
import { passJellyfinFetch } from "@/lib/jellyfinBreaker";
import { appendJsonLine } from "@/lib/logFile";
import { SERVER_LOG_FILE, SERVER_LOG_KEEP } from "@/lib/logger";

/**
 * Le journal du téléchargement hors ligne (bêta, 19/10/2026) : qui a demandé quoi, quand la version
 * a été prête, en combien de temps, qui l'a récupérée, et quand elle a quitté le serveur.
 *
 * Dans `server.log`, `scope: "offline"`, à côté des lignes `scope: "download"` du fichier d'origine
 * (`logDownload`) — et non dans un journal à lui ni dans ceux de `eventLogs.ts`. Les deux gestes
 * répondent à la même question (« qui a emporté quoi »), et l'Activité les lit déjà dans ce fichier :
 * la vue Journaux, le filtre par compte, et la liste des erreurs du serveur, où une préparation qui
 * échoue apparaissait déjà sous `offline` (c'était un `logError`). Soixante générations : le même
 * historique que le reste du serveur. Bornée : une ligne par geste, jamais une par plage servie.
 *
 * Ne lève jamais, et ne fait jamais attendre : le titre se résout à part (`resolveOfflineTitles`),
 * puis la ligne s'écrit — une préparation ou un téléchargement ne dépendent pas de leur journal.
 */

export type OfflineEvent =
  /** Un compte a demandé une version (`copy` : prête, en préparation, relancée, nouvelle). */
  | "requested"
  /** La préparation a commencé (ou recommencé, `generation`). */
  | "started"
  /** Prête : durée, taille, vitesse par rapport au temps réel. */
  | "ready"
  /** Échec, avec sa raison. */
  | "failed"
  /** Un appareil a reçu la dernière plage du fichier fini — une fois par compte et par version. */
  | "fetched"
  /** Le compte a retiré sa demande avant que la version soit prête (`stopped` : plus personne ne l'attendait). */
  | "cancelled"
  /** Le compte a supprimé de son appareil une version prête (elle reste sur le serveur). */
  | "removed"
  /** Effacée du serveur par le balayage (plus téléchargée depuis trois jours, ou échec de la veille). */
  | "expired"
  /** Effacée du serveur par l'administrateur, depuis l'Activité. */
  | "deleted"
  /** Effacée du serveur pour tenir dans sa place (`OFFLINE_SERVER_QUOTA_GB`), une fois récupérée par tous. */
  | "evicted";

const MESSAGES: Record<OfflineEvent, string> = {
  requested: "téléchargement demandé",
  started: "préparation commencée",
  ready: "version prête",
  failed: "préparation échouée",
  fetched: "fichier récupéré par l'appareil",
  cancelled: "demande annulée",
  removed: "supprimé de l'appareil",
  expired: "effacé du serveur (expiré)",
  deleted: "effacé du serveur par l'administrateur",
  evicted: "effacé du serveur (place)",
};

/** Ce qu'une ligne dit de la version concernée. */
export interface OfflineEventJob {
  id: string;
  itemId: string;
  quality: string;
  codec: string;
  audioIndex: number;
}

/** Ce que Jellyfin dit d'un titre, pour le nommer. */
export interface JellyfinNaming {
  Type?: string;
  Name?: string;
  SeriesName?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  MediaSources?: { MediaStreams?: { Type?: string; Index?: number; DisplayTitle?: string; Language?: string }[] }[];
}

export interface OfflineTitle {
  /** `null` quand Jellyfin ne donne aucun nom : la ligne et la liste gardent alors l'identifiant. */
  title: string | null;
  /** Le nom de chaque piste son, par son index dans le fichier. */
  audio: Record<number, string>;
}

/** « Série — S01E02 » pour un épisode, le nom pour un film. */
export function titleOfItem(item: JellyfinNaming): string {
  const name = item.Name ?? "?";
  if (item.Type !== "Episode" || !item.SeriesName) return name;
  const pad = (n: number | undefined) => (typeof n === "number" ? String(n).padStart(2, "0") : "?");
  return `${item.SeriesName} — S${pad(item.ParentIndexNumber)}E${pad(item.IndexNumber)}`;
}

function namingOf(item: JellyfinNaming): OfflineTitle {
  const audio: Record<number, string> = {};
  for (const s of item.MediaSources?.[0]?.MediaStreams ?? []) {
    if (s.Type === "Audio" && typeof s.Index === "number") audio[s.Index] = s.DisplayTitle ?? s.Language ?? `#${s.Index}`;
  }
  return { title: item.Name || item.SeriesName ? titleOfItem(item) : null, audio };
}

// Sur `globalThis`, comme l'état des préparations (`jobs.ts`) : les routes et `instrumentation.ts`
// auraient chacun leur copie. Bornée : au-delà, les plus anciennes s'en vont (et se relisent).
const TITLES_KEY = Symbol.for("cine-app.offlineTitles");
const MAX_TITLES = 2000;
const holder = globalThis as typeof globalThis & { [TITLES_KEY]?: Map<string, OfflineTitle> };
const titles: Map<string, OfflineTitle> = (holder[TITLES_KEY] ??= new Map());

/** Noté chaque fois que Jellyfin vient de décrire le titre (`describeItem`) : rien à redemander. */
export function noteOfflineTitle(itemId: string, item: JellyfinNaming): void {
  titles.delete(itemId);
  titles.set(itemId, namingOf(item));
  while (titles.size > MAX_TITLES) titles.delete(titles.keys().next().value as string);
}

/**
 * Le nom de chaque titre, d'un seul appel à Jellyfin pour ceux qu'on ne connaît pas encore. Un titre
 * que Jellyfin ne connaît plus (retiré de la bibliothèque) reste absent : la ligne garde son `itemId`.
 */
export async function resolveOfflineTitles(itemIds: string[]): Promise<Map<string, OfflineTitle>> {
  const out = new Map<string, OfflineTitle>();
  const missing: string[] = [];
  for (const id of new Set(itemIds)) {
    const known = titles.get(id);
    if (known) out.set(id, known);
    else missing.push(id);
  }
  // Par paquets de cinquante : une adresse de quelques kilo-octets au plus.
  for (let i = 0; i < missing.length; i += 50) {
    const batch = missing.slice(i, i + 50);
    try {
      const res = await passJellyfinFetch(`${config.jellyfin.url}/Items?ids=${batch.map(jellyfinIdSegment).join(",")}&fields=MediaSources`, {
        headers: jellyfinAuthHeaders(config.jellyfin.apiKey),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const page = (await res.json()) as { Items?: (JellyfinNaming & { Id?: string })[] };
      for (const item of page.Items ?? []) {
        if (!item.Id) continue;
        noteOfflineTitle(item.Id, item);
        out.set(item.Id, titles.get(item.Id)!);
      }
    } catch {
      /* Jellyfin injoignable : les lignes et la liste gardent l'identifiant */
    }
  }
  return out;
}

/**
 * Écrit une ligne. `user` pour un geste d'un compte ; `accounts` pour ce qui arrive à la version
 * elle-même (prête, échouée, expirée), qui sert tous ceux qui l'ont demandée.
 */
export async function logOfflineEvent(
  event: OfflineEvent,
  job: OfflineEventJob,
  fields: { user?: string; accounts?: string[]; level?: "info" | "error" } & Record<string, unknown> = {}
): Promise<void> {
  try {
    const naming = (await resolveOfflineTitles([job.itemId])).get(job.itemId);
    const { level = "info", ...rest } = fields;
    const reason = typeof rest.reason === "string" ? rest.reason : null;
    const entry = {
      timestamp: new Date().toISOString(),
      // Une préparation qui échoue reste une erreur du serveur, comptée comme avant sous `offline`.
      level,
      scope: "offline",
      event,
      message: reason ? `${MESSAGES[event]} : ${reason}` : MESSAGES[event],
      jobId: job.id,
      itemId: job.itemId,
      title: naming?.title ?? null,
      quality: job.quality,
      codec: job.codec,
      audioIndex: job.audioIndex,
      audio: naming?.audio[job.audioIndex] ?? null,
      ...rest,
    };
    const line = `${entry.message}${entry.title ? ` — ${entry.title}` : ""}`;
    const details = { compte: rest.user ?? rest.accounts, qualité: job.quality, codec: job.codec, Mo: typeof rest.bytes === "number" ? Math.round(rest.bytes / 1e6) : null };
    if (level === "error") taskError("hors ligne", line, details);
    else taskLog("hors ligne", line, details);
    appendJsonLine(SERVER_LOG_FILE, entry, { keep: SERVER_LOG_KEEP });
  } catch {
    /* une ligne perdue ne coûte rien au téléchargement */
  }
}

// « Récupéré » une fois par compte et par version : la dernière plage peut être redemandée (une
// reprise, un second appareil du même compte). En mémoire et borné : un redémarrage peut l'écrire
// une seconde fois, ce qui ne trompe personne — la ligne dit la même chose.
const FETCHED_KEY = Symbol.for("cine-app.offlineFetched");
const MAX_FETCHED = 5000;
const fetchedHolder = globalThis as typeof globalThis & { [FETCHED_KEY]?: Set<string> };
const fetched: Set<string> = (fetchedHolder[FETCHED_KEY] ??= new Set());

/**
 * Appelée par la route du fichier à chaque plage servie : n'écrit que la première fois que la
 * dernière plage d'une version finie part vers ce compte.
 */
export function noteOfflineServed(
  account: string,
  job: OfflineEventJob & { status: string; bytes: number; generation: number },
  end: number
): void {
  if (job.status !== "done" || end !== job.bytes - 1) return;
  const key = `${account}\n${job.id}\n${job.generation}`;
  if (fetched.has(key)) return;
  fetched.add(key);
  while (fetched.size > MAX_FETCHED) fetched.delete(fetched.values().next().value as string);
  void logOfflineEvent("fetched", job, { user: account, bytes: job.bytes });
}

export const __testing = {
  reset: () => {
    titles.clear();
    fetched.clear();
  },
};
