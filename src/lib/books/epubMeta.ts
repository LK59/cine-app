import { inflateRawSync } from "node:zlib";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { passJellyfinFetch } from "@/lib/jellyfinBreaker";
import { jellyfinIdSegment } from "@/lib/jellyfinPath";
import { logError } from "@/lib/logger";

/**
 * Ce que l'EPUB dit de lui-même (DECISIONS.md §127) : sa série, son rang dans la série, ses sujets.
 *
 * Jellyfin donne à un livre le nom de son **dossier** pour série : une bibliothèque rangée par auteur
 * (`/livres/<Auteur>/<livre>.epub`, ce que fait le greffon des livres) faisait de chaque roman isolé un
 * tome de la « série » de son auteur. La vraie série est dans le paquet OPF de l'EPUB —
 * `calibre:series` / `calibre:series_index`, ou en EPUB 3 `belongs-to-collection` / `group-position`.
 *
 * On n'en lit que le nécessaire, par plages, à travers le relais de téléchargement de Jellyfin : la fin
 * du fichier (le répertoire central du zip), puis `META-INF/container.xml`, puis l'OPF — quelques
 * dizaines de kilo-octets, jamais le livre. Une fois par fichier : le résultat est gardé en base
 * (`book_meta`), avec l'empreinte du fichier chez Jellyfin (`Etag`) — un fichier remplacé est relu. La
 * lecture se fait en arrière-plan, deux à la fois ; la grille ne l'attend jamais, elle prend la décision
 * de repli (`decideSeries`) en attendant.
 */

export interface EpubMeta {
  series: string | null;
  seriesIndex: number | null;
  subjects: string[];
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

const TAIL = 64 * 1024;
const MAX_ENTRY = 2 * 1024 * 1024;
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

async function readEntry(id: string, entry: ZipEntry): Promise<string> {
  if (entry.compressedSize > MAX_ENTRY) throw new Error("entrée trop grande");
  // L'en-tête local a sa propre longueur de nom et d'extra : on prend large, puis on se recale.
  const head = await range(id, entry.localOffset, entry.localOffset + 30 + 1024 + entry.compressedSize);
  const local = head.bytes.subarray(entry.localOffset - head.offset);
  if (local.readUInt32LE(0) !== 0x04034b50) throw new Error("en-tête local illisible");
  const start = 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  const data = local.subarray(start, start + entry.compressedSize);
  const raw = entry.method === 0 ? data : entry.method === 8 ? inflateRawSync(data, { maxOutputLength: MAX_ENTRY * 4 }) : null;
  if (!raw) throw new Error(`compression ${entry.method} inconnue`);
  return raw.toString("utf8");
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

/** La série, son rang et les sujets d'un OPF — Calibre (EPUB 2) ou `belongs-to-collection` (EPUB 3). */
export function parseOpf(opf: string): EpubMeta {
  const metaContent = (name: string) => {
    for (const tag of opf.match(/<(?:[\w-]+:)?meta\b[^>]*>/gi) ?? []) {
      const n = /\bname\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
      if (n?.toLowerCase() === name) return decodeXml(/\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "");
    }
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
      const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(coll[0])?.[1];
      if (id) {
        const pos = new RegExp(`<(?:[\\w-]+:)?meta\\b[^>]*refines\\s*=\\s*["']#${id.replace(/[^\w-]/g, "")}["'][^>]*property\\s*=\\s*["']group-position["'][^>]*>([^<]*)<`, "i").exec(opf)
          ?? new RegExp(`<(?:[\\w-]+:)?meta\\b[^>]*property\\s*=\\s*["']group-position["'][^>]*refines\\s*=\\s*["']#${id.replace(/[^\w-]/g, "")}["'][^>]*>([^<]*)<`, "i").exec(opf);
        if (pos) index = Number.parseFloat(pos[1]);
      }
    }
  }
  const subjects = [...opf.matchAll(/<(?:dc:)?subject\b[^>]*>([^<]*)<\/(?:dc:)?subject>/gi)].map((m) => decodeXml(m[1])).filter(Boolean);
  return { series, seriesIndex: series && Number.isFinite(index) ? index : null, subjects };
}

/** L'OPF d'un EPUB de Jellyfin, par plages. */
export async function readEpubMeta(id: string): Promise<EpubMeta> {
  const tail = await range(id, -TAIL);
  let dir = centralDirectory(tail.bytes, tail.offset);
  if (!("entries" in dir)) {
    const cd = await range(id, dir.cdOffset, dir.cdOffset + dir.cdSize - 1);
    dir = { entries: parseEntries(cd.bytes.subarray(dir.cdOffset - cd.offset)) };
  }
  const entries = dir.entries;
  const container = entries.find((e) => e.name === "META-INF/container.xml");
  const opfPath = container ? /full-path\s*=\s*["']([^"']+)["']/i.exec(await readEntry(id, container))?.[1] : undefined;
  const opf = entries.find((e) => e.name === opfPath) ?? entries.find((e) => e.name.toLowerCase().endsWith(".opf"));
  if (!opf) throw new Error("pas d'OPF");
  return parseOpf(await readEntry(id, opf));
}

// ─── Le cache et la file ────────────────────────────────────────────────────────────────────────

interface Row {
  item_id: string;
  etag: string;
  series: string | null;
  series_index: number | null;
  subjects: string;
  failed: number;
  checked_at: number;
}

/** Ce qui est connu, par livre (identifiant en minuscules) — une seule requête pour toute la bibliothèque. */
export function knownMeta(): Map<string, { etag: string; meta: EpubMeta | null; failed: boolean; checkedAt: number }> {
  const rows = getDb().prepare("SELECT item_id, etag, series, series_index, subjects, failed, checked_at FROM book_meta").all() as Row[];
  return new Map(
    rows.map((r) => [
      r.item_id,
      {
        etag: r.etag,
        failed: r.failed === 1,
        checkedAt: r.checked_at,
        meta: r.failed === 1 ? null : { series: r.series, seriesIndex: r.series_index, subjects: safeList(r.subjects) },
      },
    ])
  );
}

function safeList(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 30) : [];
  } catch {
    return [];
  }
}

function store(id: string, etag: string, meta: EpubMeta | null, now = Date.now()): void {
  getDb()
    .prepare(
      `INSERT INTO book_meta (item_id, etag, series, series_index, subjects, failed, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET etag = excluded.etag, series = excluded.series, series_index = excluded.series_index,
         subjects = excluded.subjects, failed = excluded.failed, checked_at = excluded.checked_at`
    )
    .run(id, etag, meta?.series ?? null, meta?.seriesIndex ?? null, JSON.stringify(meta?.subjects ?? []), meta ? 0 : 1, now);
}

/** Un échec (fichier illisible, Jellyfin absent) est retenté au bout d'un jour, pas à chaque grille. */
const RETRY_FAILED_MS = 24 * 3600_000;
const CONCURRENCY = 2;

// Sur `globalThis` : les routes sont des points d'entrée distincts (CLAUDE.md, « server-cache ») — une
// file par copie du module lirait deux fois le même livre.
const QUEUE_KEY = Symbol.for("laterna.books.metaQueue");
interface Queue {
  waiting: Map<string, string>;
  running: number;
}
function queue(): Queue {
  const g = globalThis as unknown as Record<symbol, Queue | undefined>;
  return (g[QUEUE_KEY] ??= { waiting: new Map(), running: 0 });
}

/** Les livres dont l'OPF reste à lire (jamais lu, fichier changé, échec ancien). */
export function staleMeta(items: readonly { id: string; etag: string | null }[], known: ReturnType<typeof knownMeta>, now = Date.now()): { id: string; etag: string }[] {
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

function pump(): void {
  const q = queue();
  while (q.running < CONCURRENCY && q.waiting.size > 0) {
    const [id, etag] = q.waiting.entries().next().value as [string, string];
    q.waiting.delete(id);
    q.running += 1;
    void readEpubMeta(id)
      .then((meta) => store(id, etag, meta))
      .catch((error: unknown) => {
        store(id, etag, null);
        logError("books/meta", error, { itemId: id });
      })
      .finally(() => {
        q.running -= 1;
        pump();
      });
  }
}

export const __testing = { queue, pump };
