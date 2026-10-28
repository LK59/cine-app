import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { logError } from "@/lib/logger";
import { taskLog } from "@/lib/taskLog";
import { bookGenres, fold, nameKey, primaryLanguage, titleKey } from "@/lib/books/metadata";
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
  /** La langue du livre (EPUB, puis bibliothèque Jellyfin) ; inconnue, celle de l'installation (`targetLanguage`). */
  language?: string | null;
  /** La série et le tome que l'EPUB déclare, quand il les déclare : un volume d'un autre tome est refusé. */
  series?: string | null;
  index?: number | null;
  /** Les autres titres du même auteur dans la bibliothèque : un résumé qui parle d'eux et pas de nous est refusé. */
  siblings?: string[];
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

/**
 * La version des règles de correspondance. Une ligne faite par des règles plus anciennes est réévaluée —
 * les remplies d'abord : la v1 a donné à « La Tour des anges » (Pullman, tome 2) le résumé du tome 1,
 * par un volume qu'elle avait cru le même (10.9.0, 28/10/2026). La v3 cherche en texte libre : la v2 ne
 * trouvait rien, Google ne répondant plus à ses opérateurs (`intitle:`, `inauthor:`, `isbn:` → 0 résultat,
 * mesuré en production le 28/10/2026).
 */
export const RULES_VERSION = 4;

/**
 * La langue d'un livre, pour la recherche (`langRestrict`), le classement des réponses et le résumé (v4,
 * 28/10/2026 : un résumé n'est pris que dans la langue du livre — « Lunatic Café », édition française, avait
 * reçu le résumé anglais d'un volume anglais, faute de candidat français décrit ; un volume d'une autre
 * langue peut encore donner l'année ou l'image). Dans l'ordre : la langue que l'EPUB déclare
 * (`dc:language`), celle des métadonnées de sa bibliothèque Jellyfin (`EnrichTarget.language` porte déjà
 * l'une ou l'autre), puis celle de l'installation (`APP_LANGUAGE`). Rien n'est supposé français : une
 * installation allemande cherche en allemand.
 */
export function targetLanguage(target: Pick<EnrichTarget, "language">): string {
  return primaryLanguage(target.language) ?? primaryLanguage(config.app?.language) ?? "en";
}

/** Ce volume est-il dans la langue du livre ? Une langue absente de la réponse n'est pas la bonne. */
export function sameLanguage(target: Pick<EnrichTarget, "language">, v: GoogleVolume): boolean {
  return primaryLanguage(v.volumeInfo?.language) === targetLanguage(target);
}

// ─── La correspondance ────────────────────────────────────────────────────────────────────────

/** Une analyse, un résumé, un guide : jamais le livre lui-même. */
const STUDY = /\b(analyse|analysis|resume|resumes|summary|fiche de lecture|fiches de lecture|etude de l oeuvre|etude|commentaire|commentaires|guide|explication|explications|lecture analytique|profil d une oeuvre|questionnaire|dossier pedagogique|bac francais)\b/;
const STUDY_PUBLISHERS = /lepetitlitteraire|le petit litteraire|encyclopaedia universalis|50minutes|50 minutes|primento|bac de francais|ilovelire|les fiches de lecture/;
/** Une intégrale, un coffret, plusieurs tomes en un : jamais le volume qu'on cherche. */
const OMNIBUS = /\b(integrale|integral|trilogie|tetralogie|saga complete|coffret|omnibus|box set|boxed set|edition complete|collection complete|oeuvres completes|(?:tomes?|volumes?|vol|livres?|books?) \d{1,2} (?:(?:a|et|to|and) )?\d{1,2})\b|\b\d{1,2} (?:(?:a|et) )?\d{1,2}$/;

const tokens = (s: string) => s.split(" ").filter((t) => t.length > 0);

/**
 * Les titres sont-ils ceux d'un même livre ? Égaux (sans article de tête, ponctuation ni accents) ; ou le
 * leur est le nôtre suivi d'un sous-titre après « : » ou « - » — et ce sous-titre n'est pas le titre d'un
 * autre livre du même auteur. Plus de « l'un contient l'autre » : c'est par là qu'un volume de la série
 * entière était passé pour le tome 2 (v1).
 */
export function titlesMatch(ours: string, theirs: string, siblings: readonly string[] = []): boolean {
  const x = titleKey(ours);
  const y = titleKey(theirs);
  if (!x || !y) return false;
  if (x === y) return true;
  const cut = /\s(?::|-|–|—)\s|:\s/.exec(theirs);
  if (!cut) return false;
  const head = titleKey(theirs.slice(0, cut.index));
  const tail = titleKey(theirs.slice(cut.index + cut[0].length));
  if (head !== x) return false;
  return !siblings.some((t) => titleKey(t) && tail.includes(titleKey(t)));
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

/** Le numéro de tome qu'un titre ou un sous-titre annonce (« tome 1 », « T2 », « vol. 3 », « livre 1 », « #4 »), ou `null`. */
export function tomeOf(text: string): number | null {
  const m = /\b(?:tome|t|vol|volume|livre|book|episode|partie)\s*(\d{1,3})\b|#\s*(\d{1,3})\b/.exec(fold(text).replace(/(\d)\s*(er|e|eme|nd)\b/g, "$1"));
  const n = m ? Number(m[1] ?? m[2]) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Un candidat retenu : le même titre, un auteur commun, et rien de ce qui trahit un autre livre — une
 * analyse, une intégrale, un autre tome, un résumé qui parle d'un autre titre de l'auteur et pas du nôtre.
 */
/** Le volume porte-t-il l'ISBN du livre ? */
export function sameIsbn(target: { isbn?: string | null }, v: GoogleVolume): boolean {
  const ours = target.isbn?.replace(/[^0-9Xx]/g, "").toUpperCase();
  if (!ours || (ours.length !== 10 && ours.length !== 13)) return false;
  return (v.volumeInfo?.industryIdentifiers ?? []).some((i) => i.identifier?.replace(/[^0-9Xx]/g, "").toUpperCase() === ours);
}

export function acceptable(target: Pick<EnrichTarget, "name" | "authors" | "index" | "siblings"> & { isbn?: string | null }, v: GoogleVolume, viaIsbn = false, titles: readonly string[] = [target.name]): boolean {
  const info = v.volumeInfo;
  if (!info?.title) return false;
  const text = fold(`${info.title} ${info.subtitle ?? ""}`);
  if (STUDY.test(text) || STUDY_PUBLISHERS.test(fold(info.publisher ?? ""))) return false;
  // Le même ISBN que le livre : c'est cette édition.
  if (sameIsbn(target, v)) return true;
  if (OMNIBUS.test(text)) return false;
  // Une adaptation (une BD « La Tour des Anges (Tome 1) » à trois auteurs) : plus d'auteurs que le livre et un tome dans le titre.
  if ((info.authors?.length ?? 0) > Math.max(1, target.authors.length) && tomeOf(`${info.title} ${info.subtitle ?? ""}`) !== null) return false;
  // Plusieurs titres de l'auteur dans le titre ou le sous-titre : un recueil.
  const siblings = target.siblings ?? [];
  if (siblings.filter((t) => titleKey(t).length >= 6 && text.includes(titleKey(t))).length >= 1 && !titles.some((t) => titleKey(t) === titleKey(info.title as string))) return false;
  // « L'inconnu de la forêt de Harlan Coben » : un titre qui porte le nom de son auteur est un ouvrage sur le livre.
  for (const author of target.authors) {
    const key = fold(author);
    if (key.length >= 5 && fold(info.title).includes(key)) return false;
    const reversed = tokens(key).reverse().join(" ");
    if (reversed.length >= 5 && fold(info.title).includes(reversed)) return false;
  }
  // Un autre tome : le nôtre est connu (OPF), le leur est écrit — ils diffèrent.
  const theirTome = tomeOf(`${info.title} ${info.subtitle ?? ""}`);
  if (target.index != null && theirTome !== null && theirTome !== Math.round(target.index)) return false;
  // Un résumé qui nomme un autre titre de l'auteur sans nommer le nôtre parle d'un autre livre.
  const about = fold(info.description ?? "");
  if (about) {
    const ours = titles.map(titleKey).filter((t) => t.length >= 4);
    const mentionsOurs = ours.some((t) => about.includes(t));
    if (!mentionsOurs && siblings.some((t) => titleKey(t).length >= 8 && about.includes(titleKey(t)))) return false;
  }
  // Par l'ISBN, le titre peut différer (sous-titre, édition) : l'auteur suffit, s'il est donné.
  if (viaIsbn) return target.authors.length === 0 || authorsMatch(target.authors, info.authors);
  return titles.some((t) => titlesMatch(t, info.title as string, siblings)) && authorsMatch(target.authors, info.authors);
}

/**
 * Le meilleur des candidats retenus, parmi tous ceux de la réponse (le bon n'est souvent pas le premier :
 * des magazines, des études, d'autres langues l'entourent) : le même ISBN, puis la langue du livre, puis un
 * résumé, le plus long, puis le moins d'auteurs en plus des nôtres.
 */
export function bestCandidate(target: EnrichTarget, items: readonly GoogleVolume[], viaIsbn = false, titles: readonly string[] = [target.name]): GoogleVolume | null {
  const ok = items.filter((v) => acceptable(target, v, viaIsbn, titles));
  if (ok.length === 0) return null;
  const key = (v: GoogleVolume): number[] => [
    sameIsbn(target, v) ? 1 : 0,
    sameLanguage(target, v) ? 1 : 0,
    // Un résumé ne compte que dans la langue du livre (v4) : ailleurs, il ne sera pas pris.
    sameLanguage(target, v) && v.volumeInfo?.description ? 1 : 0,
    sameLanguage(target, v) ? (v.volumeInfo?.description?.length ?? 0) : 0,
    -Math.max(0, (v.volumeInfo?.authors?.length ?? 0) - target.authors.length),
  ];
  return [...ok].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return 0;
  })[0];
}

/**
 * Les titres à essayer pour un livre : le sien, puis débarrassé de ce que les noms de fichiers et les
 * lots y ajoutent — un code de série en tête (« APE18 »), un numéro (« 03 », « 5 », « T3 », « Tome 3 : »),
 * le nom de la série en tête (« Alex Cross 03 Jack et Jill » → « Jack et Jill »). Sans doublons, le plus
 * probable d'abord.
 */
export function titleVariants(name: string, series: string | null = null): string[] {
  const out: string[] = [];
  const add = (t: string) => {
    const clean = t.replace(/\s+/g, " ").replace(/^[\s:.,–—-]+|[\s:.,–—-]+$/g, "").trim();
    if (clean.length >= 2 && !out.some((x) => titleKey(x) === titleKey(clean))) out.push(clean);
  };
  const original = name.trim();
  // Les codes et numéros en tête, ou isolés dans les premiers mots.
  const words = original.split(/\s+/);
  const isCode = (w: string) => /^[A-Za-z]{1,6}\d{1,4}$/.test(w) || /^\d{1,3}$/.test(w) || /^T\d{1,3}$/i.test(w);
  let k = 0;
  while (k < words.length && (isCode(words[k]) || /^(tome|t\.?)$/i.test(words[k]))) k += 1;
  const lead = words.slice(k).join(" ").replace(/^[:.\-–—]\s*/, "");
  // Un numéro au milieu des premiers mots (« L'accro du shopping 3 dit oui ») : retiré, et ce qui suit.
  const mid = /^(.{3,60}?)\s+(?:(?:tome|t\.?)\s*)?\d{1,3}\s*[:.\-–—]?\s+(.+)$/i.exec(lead);
  if (mid) add(`${mid[1]} ${mid[2]}`);
  if (lead !== original) add(lead);
  if (series) {
    const s = titleKey(series);
    const rest = titleKey(lead).startsWith(s) ? lead.slice(lead.toLowerCase().indexOf(" ", series.length - 1)).trim() : "";
    if (s && rest) add(rest.replace(/^(?:(?:tome|t\.?)\s*)?\d{1,3}\s*[:.\-–—]?\s*/i, ""));
  }
  if (mid) add(mid[2]);
  add(original);
  return out;
}

/**
 * Les genres de Google, ramenés au vocabulaire des genres de l'application par une table explicite — ses
 * catégories sont souvent celles des libraires anglo-saxons (« Fiction / Mystery & Detective / General »,
 * « Arctic regions »). Ce qui n'y figure pas est laissé.
 */
const GENRE_MAP: [RegExp, string][] = [
  [/\b(mystery|detective|crime|policier|policiers|polar|roman policier)\b/, "Policier"],
  [/\b(thriller|thrillers|suspense)\b/, "Thriller"],
  [/\b(science fiction|science-fiction|sf)\b/, "Science-fiction"],
  [/\b(fantasy|fantasie)\b/, "Fantasy"],
  [/\b(fantastique)\b/, "Fantastique"],
  [/\b(romance|romantic|sentimental)\b/, "Romance"],
  [/\b(historical|historique|history)\b/, "Historique"],
  [/\b(juvenile|young adult|jeunesse)\b/, "Jeunesse"],
  [/\b(horror|horreur|epouvante)\b/, "Horreur"],
  [/\b(biography|autobiography|biographie)\b/, "Biographie"],
  [/\b(action|adventure|aventure|aventures)\b/, "Aventure"],
  [/\b(humor|humour|humorous)\b/, "Humour"],
  [/\b(espionage|espionnage)\b/, "Espionnage"],
  [/\b(war|military|guerre)\b/, "Guerre"],
];
export function googleGenres(categories: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of categories) {
    const key = fold(raw);
    for (const [re, label] of GENRE_MAP) if (re.test(key) && !out.includes(label)) out.push(label);
  }
  return out.slice(0, 6);
}

/**
 * Ce qu'un volume apporte. L'image : la plus grande proposée, en https, agrandie quand Google le permet.
 * Le résumé : seulement si le volume est dans la langue du livre (`sameLanguage`, v4).
 */
export function recordOf(v: GoogleVolume, target: Pick<EnrichTarget, "language"> = {}): EnrichRecord {
  const info = v.volumeInfo ?? {};
  const links = info.imageLinks ?? {};
  let cover = links.large ?? links.medium ?? links.small ?? links.thumbnail ?? links.smallThumbnail ?? null;
  if (cover) {
    cover = cover.replace(/^http:/, "https:").replace(/&edge=curl/g, "");
    if (/[?&]zoom=1\b/.test(cover) && !links.large && !links.medium) cover = cover.replace(/([?&])zoom=1\b/, "$1zoom=2");
  }
  const year = Number.parseInt(info.publishedDate?.slice(0, 4) ?? "", 10);
  const overview = sameLanguage(target, v) ? plainOverview(info.description ?? "") || null : null;
  return {
    status: "filled",
    overview: overview && overview.length > 40 ? overview.slice(0, 6000) : null,
    genres: bookGenres(googleGenres(info.categories ?? [])),
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
  rules: number | null;
  status: "filled" | "nomatch";
  overview: string | null;
  genres: string;
  year: number | null;
  cover_url: string | null;
}

/** Ce qui est connu de chaque livre essayé. */
/** Les genres que l'application connaît : une ligne d'avant la table des genres (v1) n'en montre pas d'autres. */
const KNOWN_GENRES = new Set(GENRE_MAP.map(([, label]) => label));

export function knownEnrich(): Map<string, EnrichRecord & { sig: string; rules: number }> {
  let rows: Row[] = [];
  try {
    rows = getDb().prepare("SELECT item_id, sig, rules, status, overview, genres, year, cover_url FROM book_enrich").all() as Row[];
  } catch {
    return new Map();
  }
  return new Map(
    rows.map((r) => {
      let genres: string[] = [];
      try {
        const g = JSON.parse(r.genres) as unknown;
        genres = Array.isArray(g) ? g.filter((x): x is string => typeof x === "string" && KNOWN_GENRES.has(x)) : [];
      } catch {
        /* rien */
      }
      return [r.item_id, { sig: r.sig, rules: r.rules ?? 1, status: r.status, overview: r.overview, genres, year: r.year, coverUrl: r.cover_url }];
    })
  );
}

export function enrichOf(id: string): EnrichRecord | null {
  return knownEnrich().get(id) ?? null;
}

function save(id: string, sig: string, rec: EnrichRecord, googleId: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO book_enrich (item_id, sig, rules, status, overview, genres, year, cover_url, google_id, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET sig = excluded.sig, rules = excluded.rules, status = excluded.status, overview = excluded.overview, genres = excluded.genres,
         year = excluded.year, cover_url = excluded.cover_url, google_id = excluded.google_id, checked_at = excluded.checked_at`
    )
    .run(id, sig, RULES_VERSION, rec.status, rec.overview, JSON.stringify(rec.genres), rec.year, rec.coverUrl, googleId, Date.now());
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

/** Les tentatives d'une même requête quand Google répond 503 (« Service temporarily unavailable ») : une sur deux, mesuré. */
const ATTEMPTS = 3;

/**
 * Une recherche, en texte libre : `q` est encodé une seule fois, par `URLSearchParams` ; la clé va dans
 * l'en-tête. Un 503 ou une coupure est retenté jusqu'à trois fois, à 1,5–3 s d'écart (chaque tentative
 * compte dans le quota du jour), puis la file s'arrête quelques minutes.
 */
async function search(q: string, lang: string | null): Promise<GoogleVolume[]> {
  const params = new URLSearchParams({ q, maxResults: "20", printType: "books", fields: FIELDS });
  if (lang) params.set("langRestrict", lang);
  let last = "";
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) await pause(1500 + Math.round(Math.random() * 1500));
    countRequest();
    let res: Response;
    try {
      res = await state().fetcher(`${API}?${params}`, {
        headers: { "X-Goog-Api-Key": config.books.googleKey, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (error) {
      last = redact(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (res.status === 429 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw new QuotaError(`Google Books a répondu ${res.status}`);
    }
    if (res.status >= 500) {
      await res.body?.cancel().catch(() => {});
      last = `Google Books a répondu ${res.status}`;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return [];
    }
    const body = (await res.json().catch(() => ({}))) as { items?: GoogleVolume[] };
    return Array.isArray(body.items) ? body.items : [];
  }
  throw new RetryLaterError(last);
}

/**
 * Un livre, en deux requêtes au plus, **en texte libre** : `<titre> <auteur>` — Google ne répond plus à
 * `intitle:`, `inauthor:` ni `isbn:` (0 résultat, mesuré en production le 28/10/2026). D'abord la variante
 * la plus probable du titre (`titleVariants`) dans la langue du livre (`targetLanguage`), puis la suivante (ou la même sans restriction de
 * langue) si rien n'est retenu. L'ISBN du livre sert à reconnaître la bonne édition parmi les réponses.
 */
async function lookup(target: EnrichTarget): Promise<GoogleVolume | null> {
  const titles = titleVariants(target.name, target.series ?? null);
  const author = (target.authors[0] ?? "").trim();
  const query = (title: string) => `${title} ${author}`.trim();
  const lang = targetLanguage(target);
  const tries: [string, string | null][] = [[query(titles[0]), lang], titles[1] ? [query(titles[1]), lang] : [query(titles[0]), null]];
  for (let i = 0; i < tries.length; i++) {
    if (i > 0) await pause(GAP_MS);
    const hit = bestCandidate(target, await search(tries[i][0], tries[i][1]), false, titles);
    if (hit) return hit;
  }
  return null;
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
    // À essayer : jamais essayés, métadonnées changées, ou essayés par des règles plus anciennes — ceux
    // que d'anciennes règles ont remplis d'abord (un mauvais résumé se corrige avant tout le reste).
    const due = (t: EnrichTarget) => {
      const k = known.get(t.id);
      return !k || k.sig !== signature(t) || k.rules < RULES_VERSION;
    };
    const stale = (t: EnrichTarget) => {
      const k = known.get(t.id);
      return k && k.rules < RULES_VERSION && k.status === "filled" ? 0 : 1;
    };
    const all = await s.targets();
    const recheck = all.filter((t) => stale(t) === 0 && due(t));
    const queue = [...recheck, ...ordered(all).filter((t) => due(t) && stale(t) === 1)];
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
          save(target.id, signature(target), recordOf(hit, target), hit.id ?? null);
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
