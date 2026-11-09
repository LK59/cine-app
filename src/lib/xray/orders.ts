import { jellyfin } from "@/lib/clients/jellyfin";
import { xray, xrayConfigured, type XrayJob, type XrayJobAnswer, type XrayPriority } from "@/lib/clients/xray";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { logError } from "@/lib/logger";
import { taskLog } from "@/lib/taskLog";
import { analysisTarget, castOf, castWithPhotos, nextEpisodeAfter } from "./cast";

/**
 * Commander l'analyse des acteurs à l'écran (DECISIONS.md §138).
 *
 * Le déclencheur est la ligne `start` du journal du lecteur (`/api/player/log`) : la seule que les deux
 * lecteurs écrivent — le natif, le lecteur du serveur (AirPlay compris) et le Chromecast —, avec
 * l'élément et la position (`at`). Le rapport de lecture à Jellyfin (`/api/jellyfin/playback/playing`)
 * n'est envoyé que par le lecteur natif : le lecteur du serveur s'annonce par sa négociation.
 *
 * L'élément regardé part en priorité `high`, à partir de la position (`startAt`) ; l'épisode suivant de
 * la série en `normal`. Tout est **sans attente** : l'appelant n'attend jamais rien d'ici, et une erreur
 * ne sort pas — elle va dans `server.log` (`logError`). Une commande par élément, pas une par ligne : un
 * film reconstruit réécrit son `start`, et chaque relance du lecteur du serveur aussi.
 */

/** Une commande vaut six heures : au-delà, la redemander ne coûte qu'une réponse « déjà fait » du service. */
const ORDER_MEMORY_MS = 6 * 3600_000;
/** Un échec est retenté au bout de dix minutes, pas à chaque ligne : un service arrêté ne se fait pas marteler. */
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
const MAX_REMEMBERED = 2000;
/** Par compte et par heure, les commandes neuves qu'une lecture peut provoquer : un client qui boucle ne fait pas tout analyser. */
const ORDERS_PER_ACCOUNT_HOUR = 30;

const RANK: Record<XrayPriority, number> = { low: 0, normal: 1, high: 2 };

interface Remembered {
  at: number;
  priority: XrayPriority;
}

interface OrderState {
  orders: Map<string, Remembered>;
  perAccount: Map<string, number[]>;
}

/**
 * Sur `globalThis` (CLAUDE.md, « The cache's state lives on `globalThis` ») : la route du journal et
 * celle de l'administrateur sont compilées chacune avec sa copie du module.
 */
function state(): OrderState {
  const key = Symbol.for("cine-app.xrayOrders");
  const g = globalThis as unknown as Record<symbol, OrderState | undefined>;
  return (g[key] ??= { orders: new Map(), perAccount: new Map() });
}

/** Pour les tests. */
export function forgetXrayOrders(): void {
  const s = state();
  s.orders.clear();
  s.perAccount.clear();
}

export type OrderOutcome =
  | { status: "off" }
  | { status: "skipped"; reason: "recent" | "limit" }
  | { status: "unavailable"; reason: "no-file" | "no-cast" }
  | { status: "ordered"; answer: XrayJobAnswer; cast: number }
  | { status: "failed"; error: string };

export interface OrderOptions {
  priority: XrayPriority;
  /** La position d'où commencer, en secondes ; le service fait le début ensuite. */
  startAt?: number;
  /** Le compte qui l'a provoquée, pour la borne horaire ; absent pour l'administrateur. */
  account?: string;
  /** L'administrateur (banc) : passe outre la mémoire des commandes. */
  force?: boolean;
}

function remember(itemId: string, value: Remembered): void {
  const { orders } = state();
  orders.delete(itemId);
  orders.set(itemId, value);
  while (orders.size > MAX_REMEMBERED) {
    const oldest = orders.keys().next().value;
    if (oldest === undefined) break;
    orders.delete(oldest);
  }
}

/** La borne horaire d'un compte : `true` si une commande de plus est permise (et la compte). */
function accountAllows(account: string, now: number): boolean {
  const { perAccount } = state();
  const recent = (perAccount.get(account) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= ORDERS_PER_ACCOUNT_HOUR) {
    perAccount.set(account, recent);
    return false;
  }
  recent.push(now);
  perAccount.set(account, recent);
  return true;
}

/**
 * Commande l'analyse d'un élément et rend ce qui s'est passé. Ne lève jamais : un échec est rendu
 * (`failed`) et écrit dans `server.log`.
 */
export async function orderAnalysis(itemId: string, options: OrderOptions, now = Date.now()): Promise<OrderOutcome> {
  if (!xrayConfigured()) return { status: "off" };
  if (!isJellyfinId(itemId)) return { status: "unavailable", reason: "no-file" };
  const id = itemId.toLowerCase();
  const known = state().orders.get(id);
  if (!options.force && known && now - known.at < ORDER_MEMORY_MS && RANK[known.priority] >= RANK[options.priority]) {
    return { status: "skipped", reason: "recent" };
  }
  if (!options.force && options.account && !accountAllows(options.account, now)) return { status: "skipped", reason: "limit" };
  // Retenue avant le premier appel : deux lignes `start` arrivées ensemble ne commandent qu'une fois.
  remember(id, { at: now, priority: options.priority });
  try {
    const target = await analysisTarget(id);
    if (!target) return { status: "unavailable", reason: "no-file" };
    // Sans distribution, le service n'aurait aucun visage à nommer : rien n'est commandé.
    const cast = target.tmdb ? await castOf(target.tmdb) : [];
    if (cast.length === 0) return { status: "unavailable", reason: "no-cast" };
    const job: XrayJob = {
      itemId: id,
      path: target.path,
      etag: target.etag,
      priority: options.priority,
      ...(options.startAt && options.startAt > 0 ? { startAt: Math.round(options.startAt * 1000) / 1000 } : {}),
      seriesId: target.seriesId,
      cast: await castWithPhotos(cast),
    };
    const answer = await xray.enqueue(job);
    // Une ligne par vraie commande : « déjà fait » au même fichier n'en est pas une.
    if (answer.status !== "done") {
      taskLog("acteurs", "analyse commandée", {
        élément: id,
        priorité: options.priority,
        début: job.startAt ? Math.round(job.startAt) : null,
        distribution: cast.length,
        état: answer.status,
        rang: answer.position,
      });
    }
    return { status: "ordered", answer, cast: cast.length };
  } catch (error) {
    // Retentée dans dix minutes, pas à la ligne suivante.
    remember(id, { at: now - ORDER_MEMORY_MS + RETRY_AFTER_FAILURE_MS, priority: options.priority });
    logError("xray/order", error, { itemId: id, priority: options.priority });
    return { status: "failed", error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) };
  }
}

/**
 * Une lecture commence : l'élément en `high` à partir de la position, puis — pour un épisode — le
 * suivant en `normal`. Rien n'est attendu, rien ne sort : la ligne du journal est déjà écrite.
 */
export function noteSessionStart(itemId: unknown, position: unknown, account: string): void {
  try {
    if (!xrayConfigured() || !isJellyfinId(itemId)) return;
    const at = typeof position === "number" && Number.isFinite(position) && position > 0 ? position : undefined;
    void (async () => {
      const outcome = await orderAnalysis(itemId, { priority: "high", startAt: at, account });
      // L'épisode suivant, seulement quand celui-ci a été commandé ou l'était déjà : un élément sans
      // fichier ni distribution n'entraîne pas la série.
      if (outcome.status !== "ordered" && !(outcome.status === "skipped" && outcome.reason === "recent")) return;
      const target = await analysisTarget(itemId.toLowerCase());
      if (target?.type !== "Episode" || !target.seriesId) return;
      const next = nextEpisodeAfter(await jellyfin.getEpisodesAdmin(target.seriesId), target.itemId);
      if (next) await orderAnalysis(next, { priority: "normal", account });
    })().catch((error: unknown) => logError("xray/next", error, { itemId }));
  } catch (error) {
    // Sur le chemin du journal du lecteur : rien d'ici ne doit faire échouer la ligne.
    logError("xray/note", error);
  }
}
