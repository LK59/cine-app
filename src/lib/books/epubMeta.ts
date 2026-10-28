import { inflateRawSync } from "node:zlib";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { passJellyfinFetch } from "@/lib/jellyfinBreaker";
import { jellyfinIdSegment } from "@/lib/jellyfinPath";
import { logError } from "@/lib/logger";
import { anyPlaybackBeat } from "@/lib/activity/presence";

/**
 * Ce que l'EPUB dit de lui-même (DECISIONS.md §127) : sa série et son rang, ses sujets, ses auteurs,
 * l'emplacement de sa couverture.
 *
 * Jellyfin donne à un livre le nom de son **dossier** pour série (l'auteur, un lot), n'a d'auteur que
 * pour une partie des livres et de couverture que pour une autre. Le paquet OPF de l'EPUB les a presque
 * toujours : `calibre:series` / `calibre:series_index` ou `belongs-to-collection` / `group-position`,
 * `dc:creator`, `dc:subject`, `meta name="cover"` ou `properties="cover-image"`.
 *
 * On n'en lit que le nécessaire, par plages, à travers le relais de téléchargement de Jellyfin : la fin
 * du fichier (le répertoire central du zip), puis `META-INF/container.xml`, puis l'OPF — quelques
 * dizaines de kilo-octets, jamais le livre. Une fois par fichier : le résultat est gardé en base
 * (`book_meta`), avec l'empreinte du fichier chez Jellyfin (`Etag`) — un fichier remplacé est relu.
 *
 * La lecture ne doit jamais ralentir l'application : elle ne démarre qu'à la demande de la grille
 * (jamais au lancement), deux livres à la fois au plus, rend la main à la boucle entre deux livres, se
 * met en pause tant qu'un film joue (`anyPlaybackBeat`, comme l'indexation des répliques), et écrit en
 * base par lots, dans une transaction courte.
 */

export interface EpubMeta {
  series: string | null;
  seriesIndex: number | null;
  subjects: string[];
  creators: string[];
  /** Le chemin de l'image de couverture dans le zip ; `null` : l'EPUB n'en déclare pas. */
  coverPath: string | null;
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

const TAIL = 64 * 1024;
const MAX_ENTRY = 2 * 1024 * 1024;
const MAX_COVER = 8 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

/** Les octets `[start, end]` du fichier, ou la fin (`start < 0`). Le serveur peut répondre en entier (200) : on s'en accommode. */
async function range(id: string, start: number, end?: number): Promise<{ bytes: Buffer; offset: number; size: number }> {
  const header = start < 0 ? `bytes=${start}` : `bytes=${start}-${end ?? ""}`;
  const res = await passJellyfinFetch(`${config.jellyfin.url}/Items/${jellyfinIdSegment(id)}/Download`, {
    headers: { ...jellyfinAuthHeaders(config.jellyfin.apiKey), Range: header },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Jellyfin a répondu ${res.status}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(res.headers.get("content-range") ?? "");
  if (res.status === 206 && m) return { bytes, offset: Number(m[1]), size: Number(m[3]) };
  return { bytes, offset: 0, size: bytes.length };
}

/** Le répertoire central d'un zip, lu depuis sa fin. */
export function centralDirectory(tail: Buffer, tailOffset: number): { entries: ZipEntry[] } | { cdOffset: number; cdSize: number } {
  let eocd = -1;
  for (let i = tail.length - 22; i >= Math.max(0, tail.length - 22 - 65535); i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip sans fin de répertoire");
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset < tailOffset) return { cdOffset, cdSize };
  return { entries: parseEntries(tail.subarray(cdOffset - tailOffset, cdOffset - tailOffset + cdSize)) };
}

export function parseEntries(cd: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
    const method = cd.readUInt16LE(p + 10);
    const compressedSize = cd.readUInt32LE(p + 20);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    entries.push({ name, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function entriesOf(id: string): Promise<ZipEntry[]> {
  const tail = await range(id, -TAIL);
  const dir = centralDirectory(tail.bytes, tail.offset);
  if ("entries" in dir) return dir.entries;
  const cd = await range(id, dir.cdOffset, dir.cdOffset + dir.cdSize - 1);
  return parseEntries(cd.bytes.subarray(dir.cdOffset - cd.offset));
}

async function readEntry(id: string, entry: ZipEntry, max = MAX_ENTRY): Promise<Buffer> {
  if (entry.compressedSize > max) throw new Error("entrée trop grande");
  // L'en-tête local a sa propre longueur de nom et d'extra : on prend large, puis on se recale.
  const head = await range(id, entry.localOffset, entry.localOffset + 30 + 1024 + entry.compressedSize);
  const local = head.bytes.subarray(entry.localOffset - head.offset);
  if (local.readUInt32LE(0) !== 0x04034b50) throw new Error("en-tête local illisible");
  const start = 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  const data = local.subarray(start, start + entry.compressedSize);
  const raw = entry.method === 0 ? data : entry.method === 8 ? inflateRawSync(data, { maxOutputLength: max * 4 }) : null;
  if (!raw) throw new Error(`compression ${entry.method} inconnue`);
  return raw;
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#0*39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .trim();

const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];

/** Un chemin du zip, relatif au dossier de l'OPF, ramené à sa forme absolue (`OEBPS/images/cover.jpg`). */
function resolvePath(base: string, href: string): string {
  const parts = (base.includes("/") ? base.slice(0, base.lastIndexOf("/") + 1) : "").split("/").filter(Boolean);
  for (const seg of decodeURIComponent(href.split("#")[0]).split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/**
 * La série, son rang, les sujets, les auteurs et la couverture d'un OPF — Calibre (EPUB 2) ou
 * `belongs-to-collection` (EPUB 3), balises préfixées (`opf:meta`) ou non. `opfPath` résout l'adresse
 * de la couverture.
 */
export function parseOpf(opf: string, opfPath = ""): EpubMeta {
  const metas = opf.match(/<(?:[\w-]+:)?meta\b[^>]*>/gi) ?? [];
  const metaContent = (name: string) => {
    for (const tag of metas) if (attr(tag, "name")?.toLowerCase() === name) return decodeXml(attr(tag, "content") ?? "");
    return null;
  };
  let series = metaContent("calibre:series") || null;
  let index = Number.parseFloat(metaContent("calibre:series_index") ?? "");
  if (!series) {
    // EPUB 3 : <meta property="belongs-to-collection" id="c1">Série</meta>, puis
    // <meta refines="#c1" property="group-position">3</meta>.
    const coll = /<(?:[\w-]+:)?meta\b[^>]*property\s*=\s*["']belongs-to-collection["'][^>]*>([^<]*)<\/(?:[\w-]+:)?meta>/i.exec(opf);
    if (coll) {
      series = decodeXml(coll[1]) || null;
      const id = attr(coll[0], "id")?.replace(/[^\w-]/g, "");
      if (id) {
        const pos =
          new RegExp(`<(?:[\\w-]+:)?meta\\b[^>]*refines\\s*=\\s*["']#${id}["'][^>]*property\\s*=\\s*["']group-position["'][^>]*>([^<]*)<`, "i").exec(opf) ??
          new RegExp(`<(?:[\\w-]+:)?meta\\b[^>]*property\\s*=\\s*["']group-position["'][^>]*refines\\s*=\\s*["']#${id}["'][^>]*>([^<]*)<`, "i").exec(opf);
        if (pos) index = Number.parseFloat(pos[1]);
      }
    }
  }
  const subjects = [...opf.matchAll(/<(?:dc:)?subject\b[^>]*>([^<]*)<\/(?:dc:)?subject>/gi)].map((m) => decodeXml(m[1])).filter(Boolean);
  // Les auteurs : `dc:creator` dont le rôle est « aut », ou sans rôle déclaré (le cas le plus courant).
  const creators = [...opf.matchAll(/<(?:dc:)?creator\b([^>]*)>([^<]*)<\/(?:dc:)?creator>/gi)]
    .filter((m) => {
      const role = attr(m[1], "opf:role") ?? attr(m[1], "role");
      return !role || role.toLowerCase() === "aut";
    })
    .map((m) => decodeXml(m[2]))
    .filter(Boolean);
  // La couverture : `meta name="cover"` (EPUB 2) qui nomme un élément du manifeste, sinon l'élément
  // marqué `properties="cover-image"` (EPUB 3).
  const items = opf.match(/<(?:[\w-]+:)?item\b[^>]*>/gi) ?? [];
  const coverId = metaContent("cover");
  const coverItem =
    (coverId ? items.find((tag) => attr(tag, "id") === coverId && /^image\//i.test(attr(tag, "media-type") ?? "image/")) : undefined) ??
    items.find((tag) => /\bcover-image\b/i.test(attr(tag, "properties") ?? ""));
  const href = coverItem ? attr(coverItem, "href") : undefined;
  return {
    series,
    seriesIndex: series && Number.isFinite(index) ? index : null,
    subjects,
    creators: [...new Set(creators)].slice(0, 8),
    coverPath: href ? resolvePath(opfPath, href) : null,
  };
}

/** L'OPF d'un EPUB de Jellyfin, par plages. */
export async function readEpubMeta(id: string): Promise<EpubMeta> {
  const entries = await entriesOf(id);
  const container = entries.find((e) => e.name === "META-INF/container.xml");
  const opfPath = container ? /full-path\s*=\s*["']([^"']+)["']/i.exec((await readEntry(id, container)).toString("utf8"))?.[1] : undefined;
  const opf = entries.find((e) => e.name === opfPath) ?? entries.find((e) => e.name.toLowerCase().endsWith(".opf"));
  if (!opf) throw new Error("pas d'OPF");
  return parseOpf((await readEntry(id, opf)).toString("utf8"), opf.name);
}

/** Les octets de la couverture déclarée dans l'EPUB, par plages ; `null` si le zip ne l'a pas. */
export async function readEpubCover(id: string, coverPath: string): Promise<Buffer | null> {
  const entries = await entriesOf(id);
  const entry = entries.find((e) => e.name === coverPath) ?? entries.find((e) => e.name.toLowerCase() === coverPath.toLowerCase());
  return entry ? readEntry(id, entry, MAX_COVER) : null;
}

// ─── Le cache et la file ────────────────────────────────────────────────────────────────────────

interface Row {
  item_id: string;
  etag: string;
  series: string | null;
  series_index: number | null;
  subjects: string;
  creators: string | null;
  cover_path: string | null;
  failed: number;
  checked_at: number;
}

export type KnownMeta = Map<string, { etag: string; meta: EpubMeta | null; failed: boolean; checkedAt: number }>;

/** Ce qui est connu, par livre (identifiant en minuscules) — une seule requête pour toute la bibliothèque. */
export function knownMeta(): KnownMeta {
  const rows = getDb().prepare("SELECT item_id, etag, series, series_index, subjects, creators, cover_path, failed, checked_at FROM book_meta").all() as Row[];
  return new Map(
    rows.map((r) => [
      r.item_id,
      {
        etag: r.etag,
        failed: r.failed === 1,
        checkedAt: r.checked_at,
        meta:
          r.failed === 1
            ? null
            : { series: r.series, seriesIndex: r.series_index, subjects: safeList(r.subjects), creators: safeList(r.creators ?? "[]"), coverPath: r.cover_path },
      },
    ])
  );
}

/** Ce qui est connu d'un seul livre — la route de couverture. */
export function metaOf(id: string): { etag: string; meta: EpubMeta | null } | null {
  const r = getDb().prepare("SELECT item_id, etag, series, series_index, subjects, creators, cover_path, failed, checked_at FROM book_meta WHERE item_id = ?").get(id) as Row | undefined;
  if (!r) return null;
  return { etag: r.etag, meta: r.failed === 1 ? null : { series: r.series, seriesIndex: r.series_index, subjects: safeList(r.subjects), creators: safeList(r.creators ?? "[]"), coverPath: r.cover_path } };
}

function safeList(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 30) : [];
  } catch {
    return [];
  }
}

type Pending = { id: string; etag: string; meta: EpubMeta | null; at: number };

/** Les écritures en attente, écrites par lots : une transaction courte toutes les 25 lectures ou 300 ms. */
function flush(rows: Pending[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO book_meta (item_id, etag, series, series_index, subjects, creators, cover_path, failed, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET etag = excluded.etag, series = excluded.series, series_index = excluded.series_index,
       subjects = excluded.subjects, creators = excluded.creators, cover_path = excluded.cover_path, failed = excluded.failed, checked_at = excluded.checked_at`
  );
  db.transaction(() => {
    for (const r of rows) {
      stmt.run(r.id, r.etag, r.meta?.series ?? null, r.meta?.seriesIndex ?? null, JSON.stringify(r.meta?.subjects ?? []), JSON.stringify(r.meta?.creators ?? []), r.meta?.coverPath ?? null, r.meta ? 0 : 1, r.at);
    }
  })();
}

/** Un échec (fichier illisible, Jellyfin absent) est retenté au bout d'un jour, pas à chaque grille. */
const RETRY_FAILED_MS = 24 * 3600_000;
const CONCURRENCY = 2;
const BATCH = 25;
const BATCH_MS = 300;
/** Pendant un film, la file attend : on revérifie toutes les trente secondes. */
const PLAYBACK_PAUSE_MS = 30_000;

// Sur `globalThis` : les routes sont des points d'entrée distincts (CLAUDE.md, « server-cache ») — une
// file par copie du module lirait deux fois le même livre.
const QUEUE_KEY = Symbol.for("laterna.books.metaQueue");
interface Queue {
  waiting: Map<string, string>;
  running: number;
  done: Pending[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  pausedUntil: number;
  /** Augmente à chaque lot écrit : l'index des livres sait ainsi qu'il a de quoi se refaire. */
  version: number;
  /** Pour les tests : lire autrement qu'à travers Jellyfin. */
  reader: (id: string) => Promise<EpubMeta>;
  /** Pour les tests : savoir si un film joue. */
  playing: () => boolean;
}
function queue(): Queue {
  const g = globalThis as unknown as Record<symbol, Queue | undefined>;
  return (g[QUEUE_KEY] ??= { waiting: new Map(), running: 0, done: [], flushTimer: null, pausedUntil: 0, version: 0, reader: readEpubMeta, playing: () => anyPlaybackBeat() });
}

/** Les livres dont l'OPF reste à lire (jamais lu, fichier changé, échec ancien). */
export function staleMeta(items: readonly { id: string; etag: string | null }[], known: KnownMeta, now = Date.now()): { id: string; etag: string }[] {
  return items
    .filter((i) => i.etag)
    .filter((i) => {
      const k = known.get(i.id);
      if (!k || k.etag !== i.etag) return true;
      return k.failed && now - k.checkedAt > RETRY_FAILED_MS;
    }) as { id: string; etag: string }[];
}

/** Met ces livres dans la file d'arrière-plan. Ne bloque jamais, ne lève jamais. */
export function scheduleMetaReads(items: readonly { id: string; etag: string }[]): void {
  const q = queue();
  for (const i of items) if (!q.waiting.has(i.id)) q.waiting.set(i.id, i.etag);
  pump();
}

function flushSoon(force = false): void {
  const q = queue();
  if (force || q.done.length >= BATCH) {
    if (q.flushTimer) clearTimeout(q.flushTimer);
    q.flushTimer = null;
    const rows = q.done.splice(0);
    try {
      flush(rows);
      if (rows.length > 0) q.version += 1;
    } catch (error) {
      logError("books/meta", error, { where: "écriture du cache", rows: rows.length });
    }
    return;
  }
  q.flushTimer ??= setTimeout(() => {
    q.flushTimer = null;
    flushSoon(true);
  }, BATCH_MS);
}

function pump(): void {
  const q = queue();
  if (q.waiting.size === 0) return;
  // Un film joue : la file attend, sans rien lire ni écrire.
  if (q.playing()) {
    if (Date.now() >= q.pausedUntil) {
      q.pausedUntil = Date.now() + PLAYBACK_PAUSE_MS;
      setTimeout(pump, PLAYBACK_PAUSE_MS);
    }
    return;
  }
  while (q.running < CONCURRENCY && q.waiting.size > 0) {
    const [id, etag] = q.waiting.entries().next().value as [string, string];
    q.waiting.delete(id);
    q.running += 1;
    void q
      .reader(id)
      .then((meta) => {
        q.done.push({ id, etag, meta, at: Date.now() });
      })
      .catch((error: unknown) => {
        q.done.push({ id, etag, meta: null, at: Date.now() });
        logError("books/meta", error, { itemId: id });
      })
      .finally(() => {
        q.running -= 1;
        flushSoon(q.waiting.size === 0 && q.running === 0);
        // La main rendue à la boucle entre deux livres : une requête qui attend passe avant le suivant.
        setImmediate(pump);
      });
  }
}

/**
 * L'OPF d'un livre lu hors de la file (la couverture d'une carte demandée avant son tour) : il quitte la
 * file et rejoint le prochain lot écrit.
 */
export function recordMeta(id: string, etag: string, meta: EpubMeta | null): void {
  const q = queue();
  q.waiting.delete(id);
  q.done.push({ id, etag, meta, at: Date.now() });
  flushSoon();
}

/** Le numéro du dernier lot écrit (voir `Queue.version`). */
export function metaVersion(): number {
  return queue().version;
}

/** Combien de livres attendent ou sont en cours de lecture — pour les mesures. */
export function metaBacklog(): number {
  const q = queue();
  return q.waiting.size + q.running;
}

export const __testing = { queue, pump, flushSoon };
