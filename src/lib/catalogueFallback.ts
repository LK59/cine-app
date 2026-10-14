import { gunzipSync } from "node:zlib";
import { cachedJson, preparedJson, respondPrepared, type Prepared } from "@/lib/cachedJson";
import { kvCacheDb } from "@/lib/db";
import { jellyfinIsDown } from "@/lib/jellyfinBreaker";
import { requestJfId } from "@/lib/blockedTags";
import type { Locale } from "@/lib/i18n";

/**
 * Le dernier catalogue servi à chaque compte, gardé sur disque pour une panne (14/10/2026,
 * DECISIONS.md §92).
 *
 * Jellyfin injoignable, `/api/cinema/movies` et `/series` répondaient 502 : tout le catalogue
 * disparaissait, alors que Radarr et Sonarr répondaient et qu'on avait servi ce même catalogue une
 * minute plus tôt. Le bureau tombait sur un écran noir, le téléphone sur une ligne rouge.
 *
 * **Par compte, après le retrait de ce que ses tags bloqués lui cachent** (§54) : c'est exactement
 * la réponse qu'il a reçue, et rien d'un autre compte — pas même les dates « déjà vu » des séries
 * (§75), qui dépendent de lui. Compressée (le corps gzip que `cachedJson` prépare déjà, ~120 Ko pour
 * 720 films) et écrite **seulement quand elle change** : l'étiquette gardée en mémoire, et sur disque
 * à côté pour qu'un redémarrage ne réécrive pas tout. Le chemin heureux ne paie qu'une comparaison.
 *
 * Servie avec `stale: true` (et `jellyfinDown: true` quand c'est Jellyfin qui manque) : l'écran le
 * dit, et ne la fait jamais passer pour neuve. Jamais recopiée dans un cache comme une réponse
 * fraîche — à son retour, Jellyfin est relu normalement.
 */

export type CatalogueKind = "movies" | "series";

/** Ce que la réponse du catalogue porte en plus pendant une panne — absent sinon. */
export interface CatalogueOutageFlags {
  /** Le catalogue servi n'est pas celui d'aujourd'hui : c'est le dernier gardé pour ce compte. */
  stale?: true;
  /** Jellyfin est réputé hors ligne (`jellyfinBreaker.ts`) : parcourir oui, lire non. */
  jellyfinDown?: true;
  /** Quand ce catalogue de secours a été gardé (ms). */
  savedAt?: number;
}

const bodyKey = (kind: CatalogueKind, locale: Locale, account: string) => `catalogue-fallback:${kind}:${locale}:${account}`;
const etagKey = (kind: CatalogueKind, locale: Locale, account: string) => `catalogue-fallback-etag:${kind}:${locale}:${account}`;

/** L'étiquette déjà gardée sur disque, par clé : on n'écrit que ce qui a changé. */
const savedEtags = new Map<string, string>();

/** Pour les tests. */
export function forgetCatalogueFallbackMemory(): void {
  savedEtags.clear();
}

/** Le compte, tel qu'il nomme la copie : son identité Jellyfin, ou « local » pour qui n'en a pas (rien ne lui est caché). */
function accountKey(jfId: string | null): string {
  return jfId ?? "local";
}

function remember(kind: CatalogueKind, locale: Locale, account: string, prepared: Prepared, now: number): void {
  const key = bodyKey(kind, locale, account);
  let known = savedEtags.get(key);
  if (known === undefined) {
    const disk = kvCacheDb.get(etagKey(kind, locale, account));
    known = typeof disk?.value === "string" ? disk.value : "";
    savedEtags.set(key, known);
  }
  if (known === prepared.etag) return;
  kvCacheDb.set(key, { gz: prepared.gzip.toString("base64") }, now);
  kvCacheDb.set(etagKey(kind, locale, account), prepared.etag, now);
  savedEtags.set(key, prepared.etag);
}

/**
 * La réponse du catalogue, sur le chemin heureux : celle de toujours (`cachedJson`), plus la copie
 * de secours tenue à jour — et, si Jellyfin est réputé hors ligne alors que la liste vient encore
 * de la mémoire, la même réponse marquée `jellyfinDown`.
 */
export function catalogueResponse(
  req: Request,
  opts: { kind: CatalogueKind; locale: Locale; jfId: string | null; cacheKey: string; payload: object },
  now = Date.now()
): Response {
  const prepared = preparedJson(opts.cacheKey, opts.payload);
  // Hors du chemin de la réponse : une copie qui échoue ne doit jamais coûter le catalogue.
  try {
    remember(opts.kind, opts.locale, accountKey(opts.jfId), prepared, now);
  } catch {
    // Base occupée ou pleine : la prochaine réponse réessaiera.
  }
  if (jellyfinIsDown()) {
    const flags: CatalogueOutageFlags = { jellyfinDown: true };
    return cachedJson(req, `${opts.cacheKey}:down`, { ...opts.payload, ...flags });
  }
  return respondPrepared(req, prepared);
}

/**
 * Le dernier catalogue gardé pour le compte de la requête, marqué périmé — ou `null` s'il n'y en a
 * jamais eu (l'écran d'erreur prend alors le relais).
 */
export async function catalogueFallbackResponse(req: Request, kind: CatalogueKind, locale: Locale): Promise<Response | null> {
  try {
    const account = accountKey(await requestJfId(req));
    const row = kvCacheDb.get(bodyKey(kind, locale, account));
    const gz = (row?.value as { gz?: unknown } | undefined)?.gz;
    if (!row || typeof gz !== "string") return null;
    const payload = JSON.parse(gunzipSync(Buffer.from(gz, "base64")).toString("utf8")) as object;
    const flags: CatalogueOutageFlags = { stale: true, savedAt: row.fetchedAt, ...(jellyfinIsDown() ? { jellyfinDown: true as const } : {}) };
    return cachedJson(req, `${bodyKey(kind, locale, account)}:stale`, { ...payload, ...flags });
  } catch {
    // Une copie illisible ne remplace pas l'erreur d'origine.
    return null;
  }
}
