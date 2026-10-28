import { config } from "@/lib/config";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { jellyfinFetch } from "@/lib/jellyfinBreaker";
import { jellyfinIdSegment } from "@/lib/jellyfinPath";
import { blockedTagsOf, carriesBlockedTag } from "@/lib/blockedTags";
import type { SessionPayload } from "@/lib/auth";
import type { BookDetail, BookSummary } from "@/lib/books/types";
import { knownMeta, scheduleMetaReads, staleMeta, type EpubMeta } from "@/lib/books/epubMeta";
import { bookGenres, decideSeries } from "@/lib/books/metadata";

/**
 * Les livres de Jellyfin, vus par un compte (DECISIONS.md §127).
 *
 * Toujours demandés **sous l'identité du compte** (`/Users/{jfId}/Items`) : la clé d'administration
 * signe, mais c'est Jellyfin qui applique les bibliothèques permises, le contrôle parental et ses
 * propres `BlockedTags`. Par-dessus, la règle de l'application (§54) : un élément qui porte un des
 * tags bloqués du compte n'existe pas — la même fonction que le catalogue, `carriesBlockedTag`.
 *
 * L'administrateur local (sans identité Jellyfin) voit la bibliothèque entière, comme partout ailleurs
 * (`assertVisible`). Aucun cache : une grille de livres est lue à l'ouverture de la page, pas à chaque
 * lancement de l'application, et une liste gardée ici devrait suivre les droits de chaque compte.
 */

const FIELDS = "Tags,Genres,People,Overview,SeriesName,ProductionYear,ImageTags,DateCreated,Etag";
/**
 * La grille n'a pas besoin des résumés — le gros de la réponse, de loin : ils viennent avec la fiche
 * (`bookFor`). Une bibliothèque de plusieurs milliers d'EPUB ne voyage ainsi qu'en titres, séries,
 * auteurs, genres et empreintes (couverture, fichier).
 */
const LIST_FIELDS = "Tags,Genres,People,SeriesName,ProductionYear,ImageTags,DateCreated,Etag";
/** Les livres sont demandés par pages : une réponse par millier, jamais toute la bibliothèque d'un bloc. */
export const LIST_PAGE = 1000;
/** Une borne de sécurité : au-delà, la grille s'arrête plutôt que de demander sans fin. */
const LIST_MAX = 50_000;
const TIMEOUT_MS = 10_000;

interface JellyfinBookItem {
  Id: string;
  Name?: string;
  Type?: string;
  SeriesName?: string | null;
  IndexNumber?: number | null;
  ProductionYear?: number | null;
  ImageTags?: Record<string, string> | null;
  Tags?: string[] | null;
  Genres?: string[] | null;
  People?: { Name?: string; Type?: string }[] | null;
  Overview?: string | null;
  DateCreated?: string | null;
  Etag?: string | null;
  UserData?: { Played?: boolean } | null;
}

export type BookCaller = Pick<SessionPayload, "role" | "jfId">;

/** La base de l'adresse : celle du compte, ou celle du serveur pour l'administrateur local. */
function itemsBase(caller: BookCaller): string {
  if (caller.jfId) return `${config.jellyfin.url}/Users/${jellyfinIdSegment(caller.jfId)}/Items`;
  return `${config.jellyfin.url}/Items`;
}

async function getJson<T>(url: string): Promise<{ status: number; body: T | null }> {
  const res = await jellyfinFetch(url, {
    headers: jellyfinAuthHeaders(config.jellyfin.apiKey),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { status: res.status, body: null };
  }
  return { status: res.status, body: (await res.json()) as T };
}

/** Le texte d'un résumé : Jellyfin le garde parfois en HTML (le greffon des livres recopie celui de l'EPUB). */
export function plainOverview(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/<\s*(br|\/p|\/div|\/li)\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Un livre pour l'écran. La série : celle de l'EPUB quand on l'a lue (`epubMeta.ts`), sinon celle de
 * Jellyfin si elle n'est pas un nom de dossier (`decideSeries`) ; le tome suit la même source. Les
 * genres : ceux de Jellyfin et les sujets de l'EPUB, regroupés (`bookGenres`).
 */
function summaryOf(item: JellyfinBookItem, meta: EpubMeta | null = null, libraryFolders: readonly string[] = []): BookSummary {
  const authors = (item.People ?? []).filter((p) => p.Type === "Author" && p.Name).map((p) => p.Name as string);
  const seriesName = decideSeries({ opfSeries: meta?.series, jellyfinSeries: item.SeriesName, authors, libraryFolders });
  const fromOpf = !!meta?.series && seriesName === meta.series.trim();
  const index = fromOpf ? (meta?.seriesIndex ?? null) : seriesName && typeof item.IndexNumber === "number" ? item.IndexNumber : null;
  return {
    id: item.Id.toLowerCase(),
    name: item.Name?.trim() || "—",
    coverTag: item.ImageTags?.Primary ?? null,
    seriesName,
    index,
    year: typeof item.ProductionYear === "number" ? item.ProductionYear : null,
    authors,
    genres: bookGenres([...(item.Genres ?? []), ...(meta?.subjects ?? [])]),
    played: item.UserData?.Played === true,
    addedAt: item.DateCreated ? Date.parse(item.DateCreated) || null : null,
    progress: null,
  };
}

/**
 * Les noms des dossiers racines des bibliothèques de Jellyfin : un livre posé directement dedans reçoit
 * leur nom pour série. Lus avec la clé du serveur, gardés dix minutes ; une panne rend la dernière liste.
 */
let foldersCache: { at: number; names: string[] } | null = null;
async function libraryFolderNames(now = Date.now()): Promise<string[]> {
  if (foldersCache && now - foldersCache.at < 10 * 60_000) return foldersCache.names;
  try {
    const { body } = await getJson<{ Name?: string; Locations?: string[] }[]>(`${config.jellyfin.url}/Library/VirtualFolders`);
    if (!Array.isArray(body)) return foldersCache?.names ?? [];
    const names = body.flatMap((f) => [f.Name ?? "", ...(f.Locations ?? []).map((l) => l.split(/[\\/]/).filter(Boolean).pop() ?? "")]).filter(Boolean);
    foldersCache = { at: now, names };
    return names;
  } catch {
    return foldersCache?.names ?? [];
  }
}

/**
 * L'ordre de la grille : par série (les livres sans série à la fin), puis par tome (un tome inconnu
 * après les autres), puis par nom — deux livres au même tome (un hors-série numéroté comme son voisin)
 * restent dans un ordre stable.
 */
// Une seule fois : un tri de plusieurs milliers de livres en ferait sinon une par comparaison.
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function compareBooks(a: BookSummary, b: BookSummary): number {
  if (a.seriesName !== b.seriesName) {
    if (a.seriesName === null) return 1;
    if (b.seriesName === null) return -1;
    const bySeries = collator.compare(a.seriesName, b.seriesName);
    if (bySeries !== 0) return bySeries;
  }
  if (a.index !== b.index) {
    if (a.index === null) return 1;
    if (b.index === null) return -1;
    return a.index - b.index;
  }
  return collator.compare(a.name, b.name);
}

/** Les livres que ce compte voit, dans l'ordre de la grille. */
export async function listBooks(caller: BookCaller): Promise<BookSummary[]> {
  const items: JellyfinBookItem[] = [];
  for (let start = 0; start < LIST_MAX; start += LIST_PAGE) {
    const params = new URLSearchParams({
      IncludeItemTypes: "Book",
      Recursive: "true",
      Fields: LIST_FIELDS,
      EnableUserData: "true",
      EnableImageTypes: "Primary",
      SortBy: "SortName",
      StartIndex: String(start),
      Limit: String(LIST_PAGE),
    });
    const { status, body } = await getJson<{ Items?: JellyfinBookItem[]; TotalRecordCount?: number }>(`${itemsBase(caller)}?${params}`);
    if (!body) throw new Error(`Jellyfin a répondu ${status}`);
    const page = body.Items ?? [];
    items.push(...page);
    const total = typeof body.TotalRecordCount === "number" ? body.TotalRecordCount : 0;
    if (page.length < LIST_PAGE || items.length >= total) break;
  }
  const blocked = caller.jfId ? await blockedTagsOf(caller.jfId) : [];
  const books = items.filter((item) => item.Type === "Book" && typeof item.Id === "string" && !carriesBlockedTag(item.Tags, blocked));
  const known = knownMeta();
  // Les OPF pas encore lus partent en arrière-plan ; la grille de cette fois-ci fait sans.
  scheduleMetaReads(staleMeta(books.map((b) => ({ id: b.Id.toLowerCase(), etag: b.Etag ?? null })), known));
  const folders = await libraryFolderNames();
  return withoutFolderSeries(books.map((item) => summaryOf(item, known.get(item.Id.toLowerCase())?.meta ?? null, folders))).sort(compareBooks);
}

/**
 * Une « série » d'un seul livre, sans tome, n'en est pas une. Jellyfin donne à un EPUB sans série
 * déclarée le nom du dossier qui le contient : un livre posé à la racine de la bibliothèque se
 * retrouvait seul dans une série nommée comme le dossier (« books »). Le livre d'une vraie série, lui,
 * a ses voisins ou son numéro.
 */
export function withoutFolderSeries(books: BookSummary[]): BookSummary[] {
  const count = new Map<string, number>();
  for (const b of books) if (b.seriesName) count.set(b.seriesName.toLocaleLowerCase(), (count.get(b.seriesName.toLocaleLowerCase()) ?? 0) + 1);
  return books.map((b) => (b.seriesName && b.index === null && count.get(b.seriesName.toLocaleLowerCase()) === 1 ? { ...b, seriesName: null } : b));
}

/**
 * Un livre, s'il en est un et que ce compte le voit ; sinon `null` — un élément qui n'est pas un livre,
 * hors des droits du compte, ou porteur d'un de ses tags bloqués, c'est la même réponse : il n'existe pas.
 * Lève si Jellyfin n'a pas répondu (ce n'est pas un refus).
 */
export async function bookFor(caller: BookCaller, id: string): Promise<BookDetail | null> {
  const url = caller.jfId
    ? `${itemsBase(caller)}/${jellyfinIdSegment(id)}?Fields=${FIELDS}`
    : `${config.jellyfin.url}/Items?Ids=${jellyfinIdSegment(id)}&Fields=${FIELDS}&EnableUserData=true`;
  const { status, body } = await getJson<JellyfinBookItem & { Items?: JellyfinBookItem[] }>(url);
  if (!body) {
    if (status >= 400 && status < 500) return null;
    throw new Error(`Jellyfin a répondu ${status}`);
  }
  const item = caller.jfId ? body : body.Items?.[0];
  if (!item || item.Type !== "Book" || typeof item.Id !== "string") return null;
  if (caller.jfId && carriesBlockedTag(item.Tags, await blockedTagsOf(caller.jfId))) return null;
  const meta = knownMeta().get(item.Id.toLowerCase())?.meta ?? null;
  return { ...summaryOf(item, meta, await libraryFolderNames()), overview: plainOverview(item.Overview) };
}
