import { config } from "@/lib/config";
import { HttpError, upstreamSignal } from "@/lib/http";

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
}

export interface XrayScenes {
  itemId: string;
  etag: string;
  model: string;
  version: number;
  complete: boolean;
  analyzedUntil: number;
  scenes: XrayScene[];
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

  /** Oublie le résultat d'un élément (fichier remplacé). Inconnu : rien à oublier, pas une erreur. */
  forget: async (itemId: string): Promise<void> => {
    const res = await call(item(itemId), { method: "DELETE" });
    await res.arrayBuffer().catch(() => undefined);
    if (!res.ok && res.status !== 404) return refused(res, "delete");
  },
};
