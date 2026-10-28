import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { logError } from "@/lib/logger";
import { taskLog } from "@/lib/taskLog";
import { bookGenres, fold, nameKey, titleKey } from "@/lib/books/metadata";
import { plainOverview } from "@/lib/books/library";

/**
 * Compléter les livres par Google Books (option, DECISIONS.md §127) : le résumé, la couverture, les
 * genres et l'année d'un livre — **seulement ce qui manque**. Jellyfin et l'EPUB l'emportent toujours :
 * rien ici ne remplace un titre, un auteur ni une couverture (les corrections faites à la main dans
 * Jellyfin restent), et ce qui est trouvé n'est posé qu'au moment de répondre, sur les champs vides.
 *
 * Coupée par défaut. Rien ne part sans les livres allumés, l'option allumée et une clé (`config.books.googleEnrich`).
 * La clé part dans l'en-tête `X-Goog-Api-Key`, jamais dans l'adresse ; aucun journal ne la contient
 * (`redact`).
 *
 * Prudente avec le quota : un livre à la fois, deux secondes au moins entre deux requêtes, 900 requêtes
 * par jour au plus (compteur en base, remis à zéro à minuit, heure du serveur — pas à minuit heure du
 * Pacifique, comme le compte Google ; 900 laisse la marge), deux requêtes par livre au plus. Chaque livre
 * n'est essayé qu'une fois, « sans correspondance » compris — réessayé seulement si ses métadonnées
 * changent (`sig`). 429 ou 403 : arrêt jusqu'au lendemain. 503 ou réseau : on réessaie dans quelques
 * minutes, sans compter le livre comme essayé.
 *
 * Mieux vaut rien qu'un mauvais résumé : un candidat n'est retenu que si son titre et un auteur
 * correspondent, et jamais une analyse, un résumé, une fiche de lecture (`acceptable`).
 */

const API = "https://www.googleapis.com/books/v1/volumes";
const DAILY_CAP = 900;
const GAP_MS = 2_000;
const BACKOFF_MS = 5 * 60_000;
const TIMEOUT_MS = 15_000;
const FIELDS =
  "items(id,volumeInfo(title,subtitle,authors,publisher,publishedDate,description,categories,language,imageLinks,industryIdentifiers))";

export interface GoogleVolume {
  id?: string;
  volumeInfo?: {
    title?: string;
    subtitle?: string;
    authors?: string[];
    publisher?: string;
    publishedDate?: string;
    description?: string;
    categories?: string[];
    language?: string;
    imageLinks?: Record<string, string>;
    industryIdentifiers?: { type?: string; identifier?: string }[];
  };
}

export interface EnrichTarget {
  id: string;
  name: string;
  authors: string[];
  isbn: string | null;
  /** Ce qui manque à ce livre — l'ordre de la file en dépend. */
  needs: { overview: boolean; cover: boolean; genres: boolean; year: boolean };
}

export interface EnrichRecord {
  status: "filled" | "nomatch";
  overview: string | null;
  genres: string[];
  year: number | null;
  coverUrl: string | null;
}

// ─── La correspondance ────────────────────────────────────────────────────────────────────────

/** Une analyse, un résumé, un guide : jamais le livre lui-même. */
const STUDY = /\b(analyse|analysis|resume|resumes|summary|fiche de lecture|fiches de lecture|etude de l oeuvre|etude|commentaire|commentaires|guide|explication|explications|lecture analytique|profil d une oeuvre|questionnaire|dossier pedagogique|bac francais)\b/;
const STUDY_PUBLISHERS = /lepetitlitteraire|le petit litteraire|encyclopaedia universalis|50minutes|50 minutes|primento|bac de francais|ilovelire|les fiches de lecture/;

const tokens = (s: string) => s.split(" ").filter((t) => t.length > 0);

/** Les titres sont-ils ceux d'un même livre ? Égaux, ou l'un contient l'autre à 80 % des mots au moins (article ignoré). */
export function titlesMatch(a: string, b: string): boolean {
  const x = titleKey(a);
  const y = titleKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (!(x.includes(y) || y.includes(x))) return false;
  const tx = new Set(tokens(x));
  const ty = new Set(tokens(y));
  const common = [...tx].filter((t) => ty.has(t)).length;
  return common / Math.max(tx.size, ty.size) >= 0.8;
}

/** Un des auteurs est-il le nôtre ? Au moins le nom de famille (le dernier mot, dans un ordre ou l'autre). */
export function authorsMatch(ours: readonly string[], theirs: readonly string[] | undefined): boolean {
  if (!theirs?.length) return false;
  for (const mine of ours) {
    const words = tokens(nameKey(mine)).filter((t) => t.length >= 2);
    if (words.length === 0) continue;
    for (const other of theirs) {
      const theirWords = new Set(tokens(nameKey(other)));
      // Tous nos mots, ou au moins un mot long commun et le dernier mot de leur forme (« Coben »).
      if (words.every((w) => theirWords.has(w))) return true;
      const last = tokens(fold(other)).at(-1) ?? "";
      if (last.length >= 3 && words.includes(last)) return true;
    }
  }
  return false;
}

/** Un candidat retenu : le même titre, un auteur commun, et pas une analyse du livre. */
export function acceptable(target: Pick<EnrichTarget, "name" | "authors">, v: GoogleVolume, viaIsbn = false): boolean {
  const info = v.volumeInfo;
  if (!info?.title) return false;
  const text = fold(`${info.title} ${info.subtitle ?? ""}`);
  if (STUDY.test(text) || STUDY_PUBLISHERS.test(fold(info.publisher ?? ""))) return false;
  // « L'inconnu de la forêt de Harlan Coben » : un titre qui porte le nom de son auteur est un ouvrage sur le livre.
  for (const author of target.authors) {
    const key = fold(author);
    if (key.length >= 5 && fold(info.title).includes(key)) return false;
    const reversed = tokens(key).reverse().join(" ");
    if (reversed.length >= 5 && fold(info.title).includes(reversed)) return false;
  }
  // Par l'ISBN, le titre peut différer (sous-titre, édition) : l'auteur suffit, s'il est donné.
  if (viaIsbn) return target.authors.length === 0 || authorsMatch(target.authors, info.authors);
  return titlesMatch(target.name, info.title) && authorsMatch(target.authors, info.authors);
}

/** Le meilleur des candidats retenus : en français d'abord, avec un résumé ensuite. */
export function bestCandidate(target: EnrichTarget, items: readonly GoogleVolume[], viaIsbn = false): GoogleVolume | null {
  const ok = items.filter((v) => acceptable(target, v, viaIsbn));
  if (ok.length === 0) return null;
  const score = (v: GoogleVolume) => (v.volumeInfo?.language === "fr" ? 2 : 0) + (v.volumeInfo?.description ? 1 : 0);
  return [...ok].sort((a, b) => score(b) - score(a))[0];
}

/** Ce qu'un volume apporte. L'image : la plus grande proposée, en https, agrandie quand Google le permet. */
export function recordOf(v: GoogleVolume): EnrichRecord {
  const info = v.volumeInfo ?? {};
  const links = info.imageLinks ?? {};
  let cover = links.large ?? links.medium ?? links.small ?? links.thumbnail ?? links.smallThumbnail ?? null;
  if (cover) {
    cover = cover.replace(/^http:/, "https:").replace(/&edge=curl/g, "");
    if (/[?&]zoom=1\b/.test(cover) && !links.large && !links.medium) cover = cover.replace(/([?&])zoom=1\b/, "$1zoom=2");
  }
  const year = Number.parseInt(info.publishedDate?.slice(0, 4) ?? "", 10);
  const overview = plainOverview(info.description ?? "") || null;
  return {
    status: "filled",
    overview: overview && overview.length > 40 ? overview.slice(0, 6000) : null,
    genres: bookGenres(info.categories ?? []),
    year: Number.isFinite(year) && year > 1000 && year < 3000 ? year : null,
    coverUrl: cover,
  };
}

/** La signature d'un livre : ce qui, s'il change, mérite un nouvel essai. */
export function signature(t: Pick<EnrichTarget, "name" | "authors" | "isbn">): string {
  return `${titleKey(t.name)}|${nameKey(t.authors[0] ?? "")}|${t.isbn ?? ""}`;
}

/** Retire la clé de tout ce qui pourrait finir dans un journal. */
export function redact(text: string, key = config.books?.googleKey ?? ""): string {
  let out = text;
  if (key) out = out.split(key).join("[clé]");
  return out.replace(/([?&]key=)[^&\s"']+/gi, "$1[clé]");
}

// ─── La base ───────────────────────────────────────────────────────────────────────────────

interface Row {
  item_id: string;
  sig: string;
  status: "filled" | "nomatch";
  overview: string | null;
  genres: string;
  year: number | null;
  cover_url: string | null;
}

/** Ce qui est connu de chaque livre essayé. */
export function knownEnrich(): Map<string, EnrichRecord & { sig: string }> {
  let rows: Row[] = [];
  try {
    rows = getDb().prepare("SELECT item_id, sig, status, overview, genres, year, cover_url FROM book_enrich").all() as Row[];
  } catch {
    return new Map();
  }
  return new Map(
    rows.map((r) => {
      let genres: string[] = [];
      try {
        const g = JSON.parse(r.genres) as unknown;
        genres = Array.isArray(g) ? g.filter((x): x is string => typeof x === "string") : [];
      } catch {
        /* rien */
      }
      return [r.item_id, { sig: r.sig, status: r.status, overview: r.overview, genres, year: r.year, coverUrl: r.cover_url }];
    })
  );
}

export function enrichOf(id: string): EnrichRecord | null {
  return knownEnrich().get(id) ?? null;
}

function save(id: string, sig: string, rec: EnrichRecord, googleId: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO book_enrich (item_id, sig, status, overview, genres, year, cover_url, google_id, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET sig = excluded.sig, status = excluded.status, overview = excluded.overview, genres = excluded.genres,
         year = excluded.year, cover_url = excluded.cover_url, google_id = excluded.google_id, checked_at = excluded.checked_at`
    )
    .run(id, sig, rec.status, rec.overview, JSON.stringify(rec.genres), rec.year, rec.coverUrl, googleId, Date.now());
}

/** Le jour du compteur : minuit heure du serveur (le fuseau du foyer). */
export function quotaDay(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function quota(now = new Date()): { requests: number; blocked: boolean } {
  const row = getDb().prepare("SELECT requests, blocked FROM book_enrich_quota WHERE day = ?").get(quotaDay(now)) as { requests: number; blocked: number } | undefined;
  return { requests: row?.requests ?? 0, blocked: row?.blocked === 1 };
}
function countRequest(now = new Date()): void {
  getDb()
    .prepare("INSERT INTO book_enrich_quota (day, requests) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET requests = requests + 1")
    .run(quotaDay(now));
}
function blockToday(now = new Date()): void {
  getDb()
    .prepare("INSERT INTO book_enrich_quota (day, requests, blocked) VALUES (?, 0, 1) ON CONFLICT(day) DO UPDATE SET blocked = 1")
    .run(quotaDay(now));
}

// ─── La requête ────────────────────────────────────────────────────────────────────────────

class QuotaError extends Error {}
class RetryLaterError extends Error {}

/** Une recherche. `q` est encodé une seule fois, par `URLSearchParams` ; la clé va dans l'en-tête. */
async function search(q: string, lang: string | null): Promise<GoogleVolume[]> {
  const params = new URLSearchParams({ q, maxResults: "10", printType: "books", fields: FIELDS });
  if (lang) params.set("langRestrict", lang);
  countRequest();
  let res: Response;
  try {
    res = await state().fetcher(`${API}?${params}`, {
      headers: { "X-Goog-Api-Key": config.books.googleKey, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    throw new RetryLaterError(redact(error instanceof Error ? error.message : String(error)));
  }
  if (res.status === 429 || res.status === 403) {
    await res.body?.cancel().catch(() => {});
    throw new QuotaError(`Google Books a répondu ${res.status}`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    if (res.status >= 500) throw new RetryLaterError(`Google Books a répondu ${res.status}`);
    return [];
  }
  const body = (await res.json().catch(() => ({}))) as { items?: GoogleVolume[] };
  return Array.isArray(body.items) ? body.items : [];
}

/** Un livre : l'ISBN d'abord, sinon titre et auteur — en français d'abord, puis sans restriction. Deux requêtes au plus. */
async function lookup(target: EnrichTarget): Promise<GoogleVolume | null> {
  const isbn = target.isbn?.replace(/[^0-9Xx]/g, "");
  if (isbn && (isbn.length === 10 || isbn.length === 13)) {
    const hit = bestCandidate(target, await search(`isbn:${isbn}`, null), true);
    if (hit) return hit;
    await pause(GAP_MS);
  }
  // Le nom de famille : le dernier mot de l'auteur, remis dans l'ordre courant par `bookAuthors` (« Coben »).
  const surname = tokens(fold(target.authors[0] ?? "")).at(-1) ?? "";
  const q = `intitle:${target.name.trim()}${surname ? ` inauthor:${surname}` : ""}`;
  const fr = bestCandidate(target, await search(q, "fr"));
  if (fr) return fr;
  if (isbn) return null; // déjà deux requêtes
  await pause(GAP_MS);
  return bestCandidate(target, await search(q, null));
}

// ─── La file ───────────────────────────────────────────────────────────────────────────────

interface State {
  running: boolean;
  wake: ReturnType<typeof setTimeout> | null;
  version: number;
  fetcher: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** La liste à essayer, demandée à l'index (`bookIndex.ts`). */
  targets: () => Promise<EnrichTarget[]>;
}
const KEY = Symbol.for("laterna.books.google");
function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[KEY] ??= {
    running: false,
    wake: null,
    version: 0,
    fetcher: (...a) => fetch(...a),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    targets: async () => (await import("@/lib/books/bookIndex")).enrichTargets(),
  });
}
const pause = (ms: number) => state().sleep(ms);

/** Augmente à chaque livre complété : l'index sait qu'il a de quoi se refaire. */
export function enrichVersion(): number {
  return state().version;
}

/** L'ordre : le résumé d'abord, puis la couverture, puis les genres et l'année. */
export function ordered(targets: readonly EnrichTarget[]): EnrichTarget[] {
  const rank = (t: EnrichTarget) => (t.needs.overview ? 0 : t.needs.cover ? 1 : 2);
  return [...targets].filter((t) => t.needs.overview || t.needs.cover || t.needs.genres || t.needs.year).sort((a, b) => rank(a) - rank(b));
}

/**
 * Lance la file si l'option le permet (sans effet sinon, et sans effet si elle tourne déjà). Appelé par
 * le préchauffage de l'index et par l'enregistrement des réglages : allumée, elle part sans redémarrage.
 */
export function startGoogleEnrich(why = "démarrage"): void {
  const s = state();
  if (s.running || !config.books?.googleEnrich) return;
  s.running = true;
  void run(why).finally(() => {
    s.running = false;
  });
}

async function run(why: string): Promise<void> {
  const s = state();
  const stats = { asked: 0, filled: 0, nomatch: 0, errors: 0 };
  let stop: string | null = null;
  try {
    const known = knownEnrich();
    const queue = ordered(await s.targets()).filter((t) => known.get(t.id)?.sig !== signature(t));
    for (const target of queue) {
      if (!config.books?.googleEnrich) {
        stop = "option coupée";
        break;
      }
      const q = quota();
      if (q.blocked || q.requests + 2 > DAILY_CAP) {
        stop = q.blocked ? "quota de Google atteint" : "plafond du jour atteint";
        break;
      }
      stats.asked += 1;
      try {
        const hit = await lookup(target);
        if (hit) {
          save(target.id, signature(target), recordOf(hit), hit.id ?? null);
          stats.filled += 1;
          s.version += 1;
        } else {
          save(target.id, signature(target), { status: "nomatch", overview: null, genres: [], year: null, coverUrl: null }, null);
          stats.nomatch += 1;
        }
      } catch (error) {
        if (error instanceof QuotaError) {
          blockToday();
          stop = "quota de Google atteint";
          break;
        }
        stats.errors += 1;
        if (error instanceof RetryLaterError) {
          // Une panne passagère : le livre n'est pas noté essayé ; la file reprend dans quelques minutes.
          stop = "Google injoignable, reprise plus tard";
          scheduleRetry(BACKOFF_MS);
          break;
        }
        logError("books/google", new Error(redact(error instanceof Error ? error.message : String(error))), { itemId: target.id });
      }
      await pause(GAP_MS);
    }
  } catch (error) {
    logError("books/google", new Error(redact(error instanceof Error ? error.message : String(error))));
  }
  if (stats.asked > 0 || stop) {
    const remaining = Math.max(0, DAILY_CAP - quota().requests);
    taskLog("livres", "Google Books", { why, demandés: stats.asked, complétés: stats.filled, sansCorrespondance: stats.nomatch, erreurs: stats.errors, requêtesRestantes: remaining, arrêt: stop });
  }
  // Le lendemain, la file reprend d'elle-même ce qu'elle n'a pas pu faire.
  if (stop && stop !== "option coupée" && !state().wake) scheduleRetry(msUntilTomorrow());
}

function msUntilTomorrow(now = new Date()): number {
  const next = new Date(now);
  next.setHours(24, 5, 0, 0);
  return next.getTime() - now.getTime();
}

function scheduleRetry(ms: number): void {
  const s = state();
  if (s.wake) clearTimeout(s.wake);
  s.wake = setTimeout(() => {
    s.wake = null;
    startGoogleEnrich("reprise");
  }, ms);
  (s.wake as { unref?: () => void }).unref?.();
}

export const __testing = { state, run, quota, lookup, DAILY_CAP };
