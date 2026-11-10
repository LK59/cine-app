import { config } from "@/lib/config";
import { HttpError, upstreamSignal } from "@/lib/http";
import { audienceAllows, type Audience } from "@/lib/featureAudience";

/**
 * Le client de `laterna-xray` (DECISIONS.md §138) — le service à part qui reconnaît les acteurs à
 * l'image, scène par scène. Le contrat (v1) est fixé des deux côtés : `/health`, `POST /jobs`,
 * `GET /items/{id}`, `GET /items/{id}/scenes`, `DELETE /items/{id}`, une clé en `Bearer`.
 *
 * L'adresse et la clé sont relues **à chaque appel** (`config.xray`, §48) : jamais recopiées dans
 * une constante du module, qu'un réglage changé dans la gestion ne rejoindrait pas. Chaque appel a
 * sa borne — un service qui accepte la connexion sans répondre ne tient rien plus de quelques
 * secondes —, et un 404 du service (« rien sur cet élément ») se lit `null`, jamais une erreur :
 * c'est le cas ordinaire d'un titre pas encore analysé.
 */

/** Ce que `/health` dit du service : le modèle (prêt ou en téléchargement), le décodage matériel, la file. */
export interface XrayHealth {
  ok: boolean;
  version: string;
  model: { name: string; ready: boolean; license: string; error: string | null };
  decode: { vaapi: boolean; device: string | null };
  queue: { pending: number; running: string | null };
}

export type XrayPriority = "high" | "normal" | "low";

/** Une personne de la distribution, telle que le service l'attend : plusieurs photos, `image.tmdb.org` seulement. */
export interface XrayCastMember {
  personId: number;
  name: string;
  character: string;
  order: number;
  photos: string[];
}

export interface XrayJob {
  itemId: string;
  path: string;
  etag: string;
  priority: XrayPriority;
  startAt?: number;
  seriesId: string | null;
  cast: XrayCastMember[];
  /**
   * La langue d'origine du titre (ISO 639-1 de TMDB, « en ») — ajout compatible (10.30, « qui parle ») : le
   * service écoute la version originale quand le fichier l'a. Absente : la piste par défaut.
   */
  originalLanguage?: string | null;
}

export type XrayJobStatus = "queued" | "running" | "done";
export type XrayItemStatus = XrayJobStatus | "failed";

export interface XrayJobAnswer {
  itemId: string;
  status: XrayJobStatus;
  position: number;
}

export interface XrayItemState {
  itemId: string;
  etag: string;
  status: XrayItemStatus;
  progress: number;
  analyzedUntil: number;
  error: string | null;
}

export interface XrayScenePerson {
  personId: number;
  screenTime: number;
  confidence: number;
}

export interface XrayScene {
  start: number;
  end: number;
  people: XrayScenePerson[];
  /**
   * « Revenir au début de la scène » (ajout compatible du 10/11/2026, DECISIONS.md §143, `xray/app/scenecuts.py`) :
   * pour un résultat complet et mesuré, d'où repartir (reculé jusqu'au début d'une phrase commencée juste avant la
   * coupe) et si ce début de scène en est un vrai (`why` : `début`, `après-saut`, `chapitre`, `deux-signaux` ; refusé :
   * `parole`, `même-lieu`, `montage`, `îlot`, et depuis `cutsVersion` 2 `court`, `muet`, `enchaîné`). Absents sinon.
   */
  entry?: number;
  cut?: { ok: boolean; why: string };
  /**
   * `cutsVersion` 2 : les silences d'au moins 5 s qui suivent une prise de parole et **commencent** dans cette scène,
   * `[début, fin]` — la fin peut dépasser la scène. Absents d'un service d'avant.
   */
  pauses?: [number, number][];
}

export interface XrayScenes {
  itemId: string;
  etag: string;
  model: string;
  version: number;
  complete: boolean;
  analyzedUntil: number;
  scenes: XrayScene[];
  /** Ajouts compatibles du 10/11/2026 (§143) : part du temps où l'on parle (`null` : inconnue), chapitres du fichier. */
  speechShare?: number | null;
  chapters?: { kind: string; count: number; aligned: number };
  cutsVersion?: number;
}

/**
 * « Qui parle » (10.30, DECISIONS.md §138) : les segments de parole du service, chacun avec sa voix et,
 * nommée, la personne (`personId` de la distribution) et une confiance. `conflict` : la mémoire des voix de
 * la série et les visages de l'épisode se contredisent — la voix reste sans nom.
 */
export interface XrayVoiceSegment {
  start: number;
  end: number;
  voiceId: number;
  personId: number | null;
  confidence: number;
  conflict?: boolean;
}

export interface XrayVoices {
  itemId: string;
  etag: string;
  model: string;
  version: number;
  complete: boolean;
  analyzedUntil: number;
  track: { index: number; language: string | null; title: string | null; channels: number; reason: string | null } | null;
  stats?: Record<string, number | null> | null;
  segments: XrayVoiceSegment[];
}

/** La qualité des noms par série (`GET /quality`) — Configuration → Acteurs à l'écran. */
export interface XrayQualityGroup {
  seriesId: string | null;
  items: number;
  withVoices: number;
  /** Part du temps de parole qui porte un nom (moyenne des éléments) ; `null` sans voix. */
  speechNamed: number | null;
  /** Part du temps de visage à l'écran qui porte un nom. */
  facesNamed: number | null;
  voicesNamed: number;
  voicesUndecided: number;
  voicesConflict: number;
  itemsWithConflict: number;
}

export interface XrayQuality {
  overall: XrayQualityGroup;
  movies: XrayQualityGroup | null;
  series: XrayQualityGroup[];
}

/**
 * « Synchro des sous-titres » (DECISIONS.md §141, ajout compatible au contrat v1) : un ordre de mesure des
 * sous-titres texte d'un élément — ceux du conteneur, et les fichiers à côté dont on donne les chemins
 * (tels que Jellyfin les voit, le service voit la médiathèque au même chemin).
 */
export interface XraySubsyncJob {
  itemId: string;
  path: string;
  etag: string;
  priority: XrayPriority;
  externals: { path: string; language: string | null; title: string | null; forced: boolean; hi: boolean }[];
  originalLanguage?: string | null;
  force?: boolean;
}

export type XraySubsyncVerdict = "ok" | "décalé" | "dérive" | "incertain" | "montage" | "image" | "peu-de-répliques" | "erreur";

/** La mesure d'une piste, telle que le service la rend. */
export interface XraySubsyncTrack {
  trackKey: string;
  kind: "embedded" | "external";
  streamIndex: number | null;
  path: string | null;
  codec: string | null;
  language: string | null;
  title: string | null;
  forced: boolean;
  hi: boolean;
  size?: number;
  mtime?: number;
  offset: number | null;
  scale: number | null;
  scaleLabel: string | null;
  z: number | null;
  madMs: number | null;
  windows: number;
  inliers: number | null;
  cover: number | null;
  maxErrorS: number | null;
  reliable: boolean;
  confidence: "high" | "medium" | "low";
  verdict: XraySubsyncVerdict;
  speechCues?: number | null;
  error?: string;
}

export interface XraySubsyncItem {
  itemId: string;
  /** Le fichier de l'ordre en cours ; `resultEtag` celui de la mesure rendue (les deux diffèrent pendant qu'une nouvelle attend). */
  etag?: string;
  resultEtag?: string;
  status: "queued" | "running" | "done" | "failed" | "unknown";
  error?: string | null;
  position?: number;
  version?: number | null;
  speechSource?: "voix" | "parole-seule" | null;
  tracks: XraySubsyncTrack[];
  updated?: number;
}

/** Une lecture : le service est local, il répond en bien moins. */
const READ_TIMEOUT_MS = 5000;
/** Une commande : le service range l'ordre et répond, sans rien analyser avant de répondre. */
const ORDER_TIMEOUT_MS = 8000;

const trimSlash = (url: string) => url.trim().replace(/\/+$/, "");

/** Allumée, avec une adresse et une clé : sans les trois, rien ne part vers le service. */
export function xrayConfigured(): boolean {
  // Lu sur le chemin d'autres routes (le journal du lecteur) : une configuration illisible vaut
  // « coupée », jamais une erreur de la route qui demandait.
  try {
    return config.xray.enabled && config.xray.url.trim() !== "" && config.xray.apiKey.trim() !== "";
  } catch {
    return false;
  }
}

/**
 * L'option est-elle ouverte à **cette** session (`off` / `admins` / `tous`, `featureAudience.ts`, 09/11/2026) :
 * réglée sur `admins`, un compte ordinaire lit `off` et ses séances ne commandent rien. Une configuration
 * sans `audience` (un double de test, une lecture qui échoue) se lit par `enabled` : `true` vaut `tous`.
 */
export function xrayOpenTo(session: { role?: string | null } | null | undefined): boolean {
  try {
    const x = config.xray as { audience?: Audience; enabled?: boolean };
    return audienceAllows(x.audience ?? (x.enabled ? "tous" : "off"), session);
  } catch {
    return false;
  }
}

/** L'en-tête d'authentification du contrat — exporté pour le test de connexion de la Configuration. */
export function xrayAuthHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

async function call(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = READ_TIMEOUT_MS, ...rest } = init;
  return fetch(`${trimSlash(config.xray.url)}${path}`, {
    ...rest,
    headers: { ...xrayAuthHeaders(config.xray.apiKey), ...(rest.body ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
    signal: upstreamSignal(timeoutMs),
    cache: "no-store",
  });
}

async function refused(res: Response, what: string): Promise<never> {
  // Le corps peut porter la raison d'un 400 (« chemin hors de la médiathèque ») : gardé court, et
  // jamais la clé — le service ne la renvoie pas, et l'en-tête n'est pas recopié.
  const body = await res.text().catch(() => "");
  throw new HttpError(`laterna-xray ${what} : ${res.status} ${body.slice(0, 200)}`.trim(), res.status);
}

const item = (itemId: string) => `/items/${encodeURIComponent(itemId)}`;

export const xray = {
  health: async (): Promise<XrayHealth> => {
    const res = await call("/health");
    if (!res.ok) return refused(res, "health");
    return (await res.json()) as XrayHealth;
  },

  /** Commande l'analyse d'un élément. Déjà faite au même `etag` : 200 `done`, rien n'est relancé. */
  enqueue: async (job: XrayJob): Promise<XrayJobAnswer> => {
    const res = await call("/jobs", { method: "POST", body: JSON.stringify(job), timeoutMs: ORDER_TIMEOUT_MS });
    if (!res.ok) return refused(res, "jobs");
    return (await res.json()) as XrayJobAnswer;
  },

  /** L'état d'un élément, ou `null` si le service ne le connaît pas. */
  itemStatus: async (itemId: string): Promise<XrayItemState | null> => {
    const res = await call(item(itemId));
    if (res.status === 404) {
      await res.arrayBuffer().catch(() => undefined);
      return null;
    }
    if (!res.ok) return refused(res, "items");
    return (await res.json()) as XrayItemState;
  },

  /** Les scènes analysées (partielles pendant l'analyse), ou `null` s'il n'y a rien. */
  scenes: async (itemId: string): Promise<XrayScenes | null> => {
    const res = await call(`${item(itemId)}/scenes`);
    if (res.status === 404) {
      await res.arrayBuffer().catch(() => undefined);
      return null;
    }
    if (!res.ok) return refused(res, "scenes");
    return (await res.json()) as XrayScenes;
  },

  /** « Qui parle » : les segments de parole, ou `null` s'il n'y a rien (pas encore analysé, ou service d'avant 10.30). */
  voices: async (itemId: string): Promise<XrayVoices | null> => {
    const res = await call(`${item(itemId)}/voices`);
    if (res.status === 404) {
      await res.arrayBuffer().catch(() => undefined);
      return null;
    }
    if (!res.ok) return refused(res, "voices");
    return (await res.json()) as XrayVoices;
  },

  /** Refait regroupement et noms d'une série sans relire ses fichiers, dans l'ordre donné des épisodes. */
  relabelSeries: async (seriesId: string, itemIds: readonly string[] = []): Promise<{ queued: number }> => {
    const res = await call(`/series/${encodeURIComponent(seriesId)}/relabel`, { method: "POST", body: JSON.stringify({ itemIds }), timeoutMs: ORDER_TIMEOUT_MS });
    if (!res.ok) return refused(res, "relabel");
    return (await res.json()) as { queued: number };
  },

  /** Efface la mémoire des visages et des voix d'une série, puis la renomme dans l'ordre donné. */
  resetSeriesMemory: async (seriesId: string, itemIds: readonly string[] = []): Promise<{ removed: number; queued: number }> => {
    const res = await call(`/series/${encodeURIComponent(seriesId)}/memory/reset`, { method: "POST", body: JSON.stringify({ itemIds }), timeoutMs: ORDER_TIMEOUT_MS });
    if (!res.ok) return refused(res, "memory/reset");
    return (await res.json()) as { removed: number; queued: number };
  },

  quality: async (): Promise<XrayQuality> => {
    const res = await call("/quality");
    if (!res.ok) return refused(res, "quality");
    return (await res.json()) as XrayQuality;
  },

  /**
   * Commande la mesure des sous-titres d'un élément (§141) — seulement depuis un clic de l'administrateur.
   * Déjà mesuré au même fichier, mêmes fichiers à côté : 200 `done`, rien n'est relancé.
   */
  subsyncEnqueue: async (job: XraySubsyncJob): Promise<XrayJobAnswer> => {
    const res = await call("/subsync/jobs", { method: "POST", body: JSON.stringify(job), timeoutMs: ORDER_TIMEOUT_MS });
    if (!res.ok) return refused(res, "subsync/jobs");
    return (await res.json()) as XrayJobAnswer;
  },

  /** L'état et les mesures de ces éléments (200 au plus) ; un élément inconnu se lit `status: "unknown"`. */
  subsyncResults: async (itemIds: readonly string[]): Promise<XraySubsyncItem[]> => {
    if (itemIds.length === 0) return [];
    const res = await call(`/subsync/results?itemId=${itemIds.slice(0, 200).map(encodeURIComponent).join(",")}`);
    if (!res.ok) return refused(res, "subsync/results");
    return ((await res.json()) as { items?: XraySubsyncItem[] }).items ?? [];
  },

  /** Oublie le résultat d'un élément (fichier remplacé). Inconnu : rien à oublier, pas une erreur. */
  forget: async (itemId: string): Promise<void> => {
    const res = await call(item(itemId), { method: "DELETE" });
    await res.arrayBuffer().catch(() => undefined);
    if (!res.ok && res.status !== 404) return refused(res, "delete");
  },
};
