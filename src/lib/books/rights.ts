import { config } from "@/lib/config";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { jellyfinFetch } from "@/lib/jellyfinBreaker";
import { jellyfinIdSegment } from "@/lib/jellyfinPath";
import { blockedTagsOf, carriesBlockedTag } from "@/lib/blockedTags";
import type { BookCaller } from "@/lib/books/library";

/**
 * Ce qu'un compte a le droit de voir parmi les livres (DECISIONS.md §127), lu dans sa politique Jellyfin.
 *
 * L'index des livres est commun à tous les comptes (lu une fois, avec la clé du serveur) : chaque compte
 * n'en voit que ce que Jellyfin lui aurait montré — ses bibliothèques (`EnableAllFolders` /
 * `EnabledFolders`), et par-dessus la règle de l'application, ses tags bloqués (§54, `blockedTagsOf`, la
 * même fonction que le catalogue). Le contrôle parental par classification est appliqué au plus prudent :
 * `BlockUnratedItems` qui nomme les livres cache ceux sans classification, et un âge maximal cache tout
 * livre classé (l'application ne sait pas comparer les classifications d'un livre ; Jellyfin les laisse
 * presque toujours vides).
 *
 * La politique est relue toutes les deux minutes. Si Jellyfin ne répond pas et qu'on n'en connaît rien,
 * l'appel lève : la route répond 502 plutôt que de montrer la bibliothèque entière.
 */
export interface BookRights {
  /** `null` : toutes les bibliothèques. */
  folders: Set<string> | null;
  tags: readonly string[];
  blockUnrated: boolean;
  blockRated: boolean;
}

export const ALL_RIGHTS: BookRights = { folders: null, tags: [], blockUnrated: false, blockRated: false };
/** Aucune bibliothèque : ce que voit une session qui n'est ni administrateur ni un compte Jellyfin. */
const NO_RIGHTS: BookRights = { folders: new Set(), tags: [], blockUnrated: false, blockRated: false };

interface Policy {
  EnableAllFolders?: boolean;
  EnabledFolders?: string[] | null;
  BlockUnratedItems?: string[] | null;
  MaxParentalRating?: number | null;
}

const TTL_MS = 2 * 60_000;
const TIMEOUT_MS = 5000;
const KEY = Symbol.for("laterna.books.rights");
type Cache = Map<string, { policy: Policy; at: number }>;
function cache(): Cache {
  const g = globalThis as unknown as Record<symbol, Cache | undefined>;
  return (g[KEY] ??= new Map());
}

/** Un identifiant Jellyfin, sans tirets ni majuscules : la politique et les éléments ne l'écrivent pas pareil. */
export const normId = (id: string) => id.replace(/-/g, "").toLowerCase();

async function policyOf(jfId: string, now: number): Promise<Policy> {
  const known = cache().get(jfId);
  if (known && now - known.at < TTL_MS) return known.policy;
  try {
    const res = await jellyfinFetch(`${config.jellyfin.url}/Users/${jellyfinIdSegment(jfId)}`, {
      headers: jellyfinAuthHeaders(config.jellyfin.apiKey),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`Jellyfin a répondu ${res.status}`);
    }
    const policy = ((await res.json()) as { Policy?: Policy }).Policy ?? {};
    cache().set(jfId, { policy, at: now });
    if (cache().size > 200) cache().delete(cache().keys().next().value as string);
    return policy;
  } catch (error) {
    // La dernière politique connue vaut mieux que rien ; sans elle, on ne montre rien.
    if (known) return known.policy;
    throw error;
  }
}

/** Les droits de ce compte ; l'administrateur local (sans identité Jellyfin) voit tout, comme partout. */
export async function rightsOf(caller: BookCaller, now = Date.now()): Promise<BookRights> {
  // Sans compte Jellyfin, tous les droits pour l'administrateur (le préchauffage, l'administrateur du
  // `.env`) — et aucun pour qui que ce soit d'autre : une session sans identifiant ne voit rien.
  if (!caller.jfId) return caller.role === "admin" ? ALL_RIGHTS : NO_RIGHTS;
  const [policy, tags] = await Promise.all([policyOf(caller.jfId, now), blockedTagsOf(caller.jfId)]);
  const all = policy.EnableAllFolders !== false;
  return {
    folders: all ? null : new Set((policy.EnabledFolders ?? []).filter((f) => typeof f === "string").map(normId)),
    tags,
    blockUnrated: (policy.BlockUnratedItems ?? []).some((t) => typeof t === "string" && t.toLowerCase() === "book"),
    blockRated: typeof policy.MaxParentalRating === "number",
  };
}

/** La clé d'un ensemble de droits : deux comptes aux mêmes droits partagent la même vue. */
export function rightsKey(r: BookRights): string {
  const folders = r.folders ? [...r.folders].sort().join(",") : "*";
  return `${folders}|${[...r.tags].sort().join(",")}|${r.blockUnrated ? 1 : 0}${r.blockRated ? 1 : 0}`;
}

/** Ce livre est-il visible avec ces droits ? */
export function allows(r: BookRights, item: { library: string; tags: readonly string[]; rated: boolean }): boolean {
  if (r.folders && !r.folders.has(item.library)) return false;
  if (carriesBlockedTag(item.tags, r.tags)) return false;
  if (r.blockUnrated && !item.rated) return false;
  if (r.blockRated && item.rated) return false;
  return true;
}

export const __testing = { reset: () => cache().clear() };
