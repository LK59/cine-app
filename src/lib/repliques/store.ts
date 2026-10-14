import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir";

/**
 * La base des répliques : `data/repliques.db`, à part de `cine.db` (DECISIONS.md §88).
 *
 * À part pour trois raisons. Elle est **reconstructible** de bout en bout depuis les fichiers : la
 * sauvegarde quotidienne (`dbBackup.ts`) ne copie que `cine.db`, et n'a donc rien à en retirer. Elle
 * est **grosse** au regard du reste (des centaines de milliers de lignes) : un `VACUUM` ou une
 * reconstruction ne touchent jamais la base des comptes. Et la **reconstruire** se fait en supprimant
 * le fichier — instantané — plutôt qu'en effaçant des millions de lignes, ce qui tiendrait la boucle.
 *
 * Une ligne = une réplique : le film (élément Jellyfin, identifiant Radarr), la langue, le début et la
 * fin en millisecondes, le texte affiché, le texte normalisé. L'index plein texte (FTS5) porte sur le
 * texte **normalisé**, avec `unicode61 remove_diacritics 2` : « pere » trouve « Père », « coeur »
 * trouve « cœur » (plié en `oe` par `fold`, ce que le tokenizer ne fait pas seul).
 *
 * Les fautes de frappe passent par le vocabulaire (`terms`) : chaque mot indexé, avec son nombre
 * d'occurrences ; un mot cherché absent du vocabulaire est remplacé par ses voisins les plus proches
 * (distance d'édition) — voir `search.ts`. Une table trigramme sur les lignes a été mesurée et écartée
 * (taille, voir DECISIONS §88).
 *
 * **Toutes les requêtes sont synchrones** (better-sqlite3) : les écritures se font par petits lots
 * (`writeLines`, `deleteFilmLines`), chacun mesuré, avec un passage de main entre deux.
 */

export const REPLIQUES_DB_FILE = "repliques.db";

/**
 * La connexion, UNE pour tout le serveur (14/10/2026) : Next charge ce module deux fois — par le
 * moteur (`instrumentation.ts`) et par les routes —, et chaque copie avait la sienne. « Reconstruire »
 * depuis la page fermait celle des routes et supprimait le fichier ; celle du moteur restait ouverte
 * sur le fichier supprimé (son inode vivait encore), et la passe qui suivait écrivait dans un fichier
 * que plus personne ne voyait. Rangée sur `globalThis`, comme l'état du moteur (`engine.ts`).
 */
type Connection = { db: Database.Database | null; path: string | null };
const CONNECTION_KEY = Symbol.for("cine.repliques.db");
const STATS_KEY = Symbol.for("cine.repliques.writeStats");
const shared = globalThis as typeof globalThis & {
  [CONNECTION_KEY]?: Connection;
  [STATS_KEY]?: { slices: number; maxSliceMs: number; totalMs: number; overBudget: number };
};
const connection: Connection = (shared[CONNECTION_KEY] ??= { db: null, path: null });

function filePath(): string {
  return path.join(DATA_DIR, REPLIQUES_DB_FILE);
}

/** La base existe-t-elle déjà ? — sans la créer (`repliquesDb` la crée). */
export function repliquesDbExists(): boolean {
  return fs.existsSync(filePath());
}

export function repliquesDb(): Database.Database {
  const target = filePath();
  if (connection.db && connection.path === target) return connection.db;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new Database(target);
  connection.db = db;
  connection.path = target;
  db.pragma("journal_mode = WAL");
  // Sans `fsync` : une base qu'on reconstruit depuis les fichiers n'a pas à payer la durabilité. Mesuré
  // le 14/10/2026 sur 750 000 lignes : avec `NORMAL`, chaque point de contrôle synchronisait le disque
  // au commit qui le déclenchait — 1 265 tranches sur 2 000 au-delà du budget. Un plantage du
  // processus ne perd rien (WAL) ; une coupure de courant peut abîmer le fichier, et « Reconstruire »
  // le refait. L'indexation repart de toute façon du film suivant le dernier marqué fini.
  db.pragma("synchronous = OFF");
  // Des points de contrôle petits et fréquents plutôt qu'un gros de temps en temps.
  db.pragma("wal_autocheckpoint = 200");
  migrate(db);
  return db;
}

function migrate(conn: Database.Database): void {
  // Une base neuve n'a rien à réparer : elle naît à la version courante des réparations.
  const fresh = !conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lines'").get();
  conn.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS films (
      item_id     TEXT PRIMARY KEY,
      radarr_id   INTEGER NOT NULL,
      title       TEXT NOT NULL,
      path        TEXT NOT NULL,
      signature   TEXT NOT NULL,
      status      TEXT NOT NULL,            -- ok | empty | error
      sources     TEXT,                     -- JSON : d'où vient chaque langue
      error       TEXT,
      lines       INTEGER NOT NULL DEFAULT 0,
      bytes_read  INTEGER NOT NULL DEFAULT 0,
      ms          INTEGER NOT NULL DEFAULT 0,
      indexed_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lines (
      id         INTEGER PRIMARY KEY,
      item_id    TEXT NOT NULL,
      radarr_id  INTEGER NOT NULL,
      lang       TEXT NOT NULL,
      start_ms   INTEGER NOT NULL,
      end_ms     INTEGER NOT NULL,
      text       TEXT NOT NULL,
      norm       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lines_item ON lines (item_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS lines_fts USING fts5(
      norm, content='lines', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS lines_ai AFTER INSERT ON lines BEGIN
      INSERT INTO lines_fts (rowid, norm) VALUES (new.id, new.norm);
    END;
    CREATE TRIGGER IF NOT EXISTS lines_ad AFTER DELETE ON lines BEGIN
      INSERT INTO lines_fts (lines_fts, rowid, norm) VALUES ('delete', old.id, old.norm);
    END;

    CREATE TABLE IF NOT EXISTS terms (term TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID;
  `);
  // Les fusions de l'index plein texte, faites par nous et par petits morceaux (`mergeStep`) plutôt
  // qu'au commit : laissées à FTS5, elles grossissent avec l'index — une fusion de haut niveau tenait
  // la boucle 70 ms sur 750 000 lignes, et bien davantage plus tard. `crisismerge` très haut : le
  // seuil où FTS5 fusionne tout d'un coup n'est jamais atteint, nos petites fusions passant avant.
  conn.exec(`INSERT INTO lines_fts (lines_fts, rank) VALUES ('automerge', 0);
             INSERT INTO lines_fts (lines_fts, rank) VALUES ('crisismerge', 2000);`);
  if (fresh) conn.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(REPAIR_KEY, JSON.stringify({ version: REPAIR_VERSION, fresh: true }));
}

/** Ferme la base (reconstruction, tests). */
export function closeRepliquesDb(): void {
  try {
    connection.db?.close();
  } catch {
    /* déjà fermée */
  }
  connection.db = null;
  connection.path = null;
}

/**
 * Efface tout : le fichier et ses journaux WAL. Instantané quelle que soit la taille — c'est
 * « Reconstruire l'index ».
 */
export function wipeRepliquesDb(): void {
  closeRepliquesDb();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(filePath() + suffix, { force: true });
}

/** La place prise sur le disque, journal WAL compris. */
export function repliquesDbBytes(): number {
  let total = 0;
  for (const suffix of ["", "-wal"]) {
    try {
      total += fs.statSync(filePath() + suffix).size;
    } catch {
      /* absent */
    }
  }
  return total;
}

// ─── État ───────────────────────────────────────────────────────────────────

export function readMeta<T>(key: string): T | null {
  const row = repliquesDb().prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function writeMeta(key: string, value: unknown): void {
  repliquesDb()
    .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));
}

export interface FilmRecord {
  itemId: string;
  radarrId: number;
  title: string;
  path: string;
  signature: string;
  status: "ok" | "empty" | "error";
  sources: unknown;
  error: string | null;
  lines: number;
  bytesRead: number;
  ms: number;
  indexedAt: number;
}

export function filmRecords(): Map<string, { signature: string; status: string; lines: number }> {
  const rows = repliquesDb().prepare("SELECT item_id, signature, status, lines FROM films").all() as { item_id: string; signature: string; status: string; lines: number }[];
  return new Map(rows.map((r) => [r.item_id, { signature: r.signature, status: r.status, lines: r.lines }]));
}

/** Combien de répliques d'un film sont réellement dans l'index (par `lines_item`, moins d'une ms). */
export function filmLineCount(itemId: string): number {
  return (repliquesDb().prepare("SELECT COUNT(*) AS n FROM lines WHERE item_id = ?").get(itemId) as { n: number }).n;
}

/**
 * Retire les répliques écrites en double d'un film — même langue, mêmes instants, même texte — en
 * gardant la première, par tranches, et décompte leurs mots du vocabulaire. Rend combien il en reste.
 *
 * Mesuré le 14/10/2026 sur la production : avant que le moteur ne soit unique (deux passes
 * concurrentes, l'une lancée par « Forcer »), 217 films sur 599 avaient été écrits deux fois —
 * 514 000 répliques en trop sur 1,98 M, chaque résultat lu deux fois, « voir plus » compté double.
 * La signature de ces films n'a pas changé : aucune passe ne les aurait relus. Aucune lecture de
 * fichier pour réparer : les doubles sont identiques à l'octet.
 */
export async function dedupeFilmLines(itemId: string): Promise<number> {
  const conn = repliquesDb();
  const rows = conn.prepare("SELECT id, lang, start_ms, end_ms, norm FROM lines WHERE item_id = ? ORDER BY id").all(itemId) as {
    id: number;
    lang: string;
    start_ms: number;
    end_ms: number;
    norm: string;
  }[];
  const seen = new Set<string>();
  const extra: { id: number; norm: string }[] = [];
  for (const r of rows) {
    const key = `${r.lang}|${r.start_ms}|${r.end_ms}|${r.norm}`;
    if (seen.has(key)) extra.push({ id: r.id, norm: r.norm });
    else seen.add(key);
  }
  const slice = removeLines(conn);
  let size = 100;
  for (let at = 0; at < extra.length; ) {
    const part = extra.slice(at, at + size);
    const t0 = performance.now();
    slice(part);
    const ms = performance.now() - t0;
    noteSlice(ms);
    at += part.length;
    await yieldToLoop();
    mergeStep();
    if (ms < WRITE_BUDGET_MS / 3) size = Math.min(1000, Math.ceil(size * 1.5));
    else if (ms > WRITE_BUDGET_MS / 2) size = Math.max(20, Math.floor(size / 2));
    await yieldToLoop();
  }
  return rows.length - extra.length;
}

export function saveFilm(record: FilmRecord): void {
  repliquesDb()
    .prepare(
      `INSERT INTO films (item_id, radarr_id, title, path, signature, status, sources, error, lines, bytes_read, ms, indexed_at)
       VALUES (@itemId, @radarrId, @title, @path, @signature, @status, @sources, @error, @lines, @bytesRead, @ms, @indexedAt)
       ON CONFLICT(item_id) DO UPDATE SET radarr_id = excluded.radarr_id, title = excluded.title, path = excluded.path,
         signature = excluded.signature, status = excluded.status, sources = excluded.sources, error = excluded.error,
         lines = excluded.lines, bytes_read = excluded.bytes_read, ms = excluded.ms, indexed_at = excluded.indexed_at`,
    )
    .run({ ...record, sources: record.sources === null ? null : JSON.stringify(record.sources) });
}

export function forgetFilm(itemId: string): void {
  repliquesDb().prepare("DELETE FROM films WHERE item_id = ?").run(itemId);
}

export function filmErrors(limit = 50): { itemId: string; title: string; error: string; at: number }[] {
  return (
    repliquesDb().prepare("SELECT item_id, title, error, indexed_at FROM films WHERE status = 'error' ORDER BY indexed_at DESC LIMIT ?").all(limit) as {
      item_id: string;
      title: string;
      error: string;
      indexed_at: number;
    }[]
  ).map((r) => ({ itemId: r.item_id, title: r.title, error: r.error, at: r.indexed_at }));
}

export function indexCounts(): { films: number; filmsWithLines: number; lines: number; errors: number } {
  const conn = repliquesDb();
  const films = conn.prepare("SELECT COUNT(*) AS n, SUM(lines > 0) AS withLines, SUM(status = 'error') AS errors, SUM(lines) AS lines FROM films").get() as {
    n: number;
    withLines: number | null;
    errors: number | null;
    lines: number | null;
  };
  return { films: films.n, filmsWithLines: films.withLines ?? 0, lines: films.lines ?? 0, errors: films.errors ?? 0 };
}

// ─── Écritures par petits lots ──────────────────────────────────────────────

export interface LineRow {
  itemId: string;
  radarrId: number;
  lang: string;
  startMs: number;
  endMs: number;
  text: string;
  norm: string;
}

/** Le temps qu'une tranche d'écriture peut tenir la boucle d'événements. */
export const WRITE_BUDGET_MS = 12;

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Ce que les écritures ont réellement coûté — affiché dans la Configuration, « mesuré ». Partagé par
 * les copies du module (14/10/2026) : le moteur écrit, la route d'état lit, et la page affichait les
 * zéros de la copie des routes.
 */
export const writeStats = (shared[STATS_KEY] ??= { slices: 0, maxSliceMs: 0, totalMs: 0, overBudget: 0 });

function noteSlice(ms: number): void {
  writeStats.slices++;
  if (ms > WRITE_BUDGET_MS) writeStats.overBudget++;
  writeStats.totalMs += ms;
  if (ms > writeStats.maxSliceMs) writeStats.maxSliceMs = ms;
}

/**
 * Écrit les répliques d'un film par tranches : la taille d'une tranche s'ajuste pour tenir sous
 * `WRITE_BUDGET_MS` (elle double tant qu'on est loin, se divise par deux au-delà), et la boucle
 * reprend la main entre deux. Le vocabulaire (`terms`) suit, dans la même tranche que ses lignes.
 */
export async function writeLines(rows: readonly LineRow[]): Promise<void> {
  const conn = repliquesDb();
  const insert = conn.prepare("INSERT INTO lines (item_id, radarr_id, lang, start_ms, end_ms, text, norm) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const term = conn.prepare("INSERT INTO terms (term, n) VALUES (?, ?) ON CONFLICT(term) DO UPDATE SET n = n + excluded.n");
  const slice = conn.transaction((part: readonly LineRow[]) => {
    const counts = new Map<string, number>();
    for (const r of part) {
      insert.run(r.itemId, r.radarrId, r.lang, r.startMs, r.endMs, r.text, r.norm);
      for (const word of r.norm.split(" ")) if (word) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    for (const [word, n] of counts) term.run(word, n);
  });
  let size = 50;
  for (let at = 0; at < rows.length; ) {
    const part = rows.slice(at, at + size);
    const t0 = performance.now();
    slice(part);
    const ms = performance.now() - t0;
    noteSlice(ms);
    at += part.length;
    await yieldToLoop();
    mergeStep();
    if (ms < WRITE_BUDGET_MS / 3) size = Math.min(MAX_SLICE_ROWS, Math.ceil(size * 1.5));
    else if (ms > WRITE_BUDGET_MS / 2) size = Math.max(20, Math.floor(size / 2));
    await yieldToLoop();
  }
}

/**
 * Un pas de fusion de l'index plein texte, borné à quelques pages — moins de 15 ms mesurés sur
 * 750 000 lignes (contre 70 ms et plus pour les fusions que FTS5 fait seul au commit).
 */
function mergeStep(): void {
  const t0 = performance.now();
  repliquesDb().prepare("INSERT INTO lines_fts (lines_fts, rank) VALUES ('merge', 64)").run();
  noteSlice(performance.now() - t0);
}

/** Au-delà, une tranche coûte plus qu'elle n'économise de passages de main. */
const MAX_SLICE_ROWS = 400;

/**
 * Retire des répliques et décompte leurs mots du vocabulaire, dans la même transaction ; un mot qui
 * tombe à zéro sort du vocabulaire (sans quoi la correction des fautes proposait un mot que plus
 * aucune réplique ne contient). Le seul chemin des effacements : `deleteFilmLines` et
 * `dedupeFilmLines`.
 */
function removeLines(conn: Database.Database): (part: readonly { id: number; norm: string }[]) => void {
  const drop = conn.prepare("DELETE FROM lines WHERE id = ?");
  const term = conn.prepare("UPDATE terms SET n = n - ? WHERE term = ?");
  const gone = conn.prepare("DELETE FROM terms WHERE term = ? AND n <= 0");
  return conn.transaction((part: readonly { id: number; norm: string }[]) => {
    const counts = new Map<string, number>();
    for (const r of part) {
      drop.run(r.id);
      for (const word of r.norm.split(" ")) if (word) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    for (const [word, n] of counts) {
      term.run(n, word);
      gone.run(word);
    }
  });
}

/**
 * Efface les répliques d'un film, par tranches (un film relu, un film disparu), et décompte leurs mots.
 *
 * Jusqu'au 14/10/2026, les lignes partaient sans leurs mots : chaque film relu (réencodé, `.srt`
 * ajouté, interrompu par un redémarrage) ajoutait ses mots une seconde fois au vocabulaire. Mesuré
 * sur une copie de la production : 43 143 mots sur 133 570 surcomptés, 13,23 M occurrences pour
 * 12,14 M réelles, « a » à 282 764 pour 259 581, et 5 mots sans plus aucune réplique — les seuils
 * de la recherche (`TOO_COMMON`, `RARE`) et le choix des corrections lisent ces nombres.
 * L'existant est recalculé une fois par `repairIndex`.
 */
export async function deleteFilmLines(itemId: string): Promise<void> {
  const conn = repliquesDb();
  const pick = conn.prepare("SELECT id, norm FROM lines WHERE item_id = ? ORDER BY id LIMIT ?");
  const slice = removeLines(conn);
  let size = 200;
  for (;;) {
    const t0 = performance.now();
    const part = pick.all(itemId, size) as { id: number; norm: string }[];
    if (part.length > 0) slice(part);
    const ms = performance.now() - t0;
    noteSlice(ms);
    if (part.length < size) break;
    await yieldToLoop();
    mergeStep();
    if (ms < WRITE_BUDGET_MS / 3) size = Math.min(1000, Math.ceil(size * 1.5));
    else if (ms > WRITE_BUDGET_MS / 2) size = Math.max(20, Math.floor(size / 2));
    await yieldToLoop();
  }
}

// ─── Réparations en place ───────────────────────────────────────────────────

/** La clé de `meta` qui dit jusqu'où la base a été réparée. */
export const REPAIR_KEY = "repair";
/**
 * La version des réparations. 1 (14/10/2026) : le vocabulaire recalculé depuis les répliques
 * stockées (`deleteFilmLines` ne décomptait pas). Une base neuve naît à la version courante (`migrate`).
 */
export const REPAIR_VERSION = 1;

export interface RepairReport {
  version: number;
  at: number;
  /** Les répliques relues pour recompter. */
  lines: number;
  /** Les mots du vocabulaire avant la réparation. */
  terms: number;
  /** Mots dont le compte était faux, mots sans plus aucune réplique, mots qui manquaient. */
  fixed: number;
  removed: number;
  added: number;
  /** Les occurrences comptées avant et après — l'écart est ce qui était surcompté. */
  totalBefore: number;
  totalAfter: number;
  slices: number;
  maxSliceMs: number;
  /** Le temps tenu par la boucle, et le temps écoulé de bout en bout (mains rendues comprises). */
  busyMs: number;
  elapsedMs: number;
}

/**
 * Remet la base d'aplomb **depuis ce qu'elle contient** — aucun film n'est relu (DECISIONS §88,
 * 14/10/2026). Une fois par version (`REPAIR_KEY` dans `meta`), idempotente : relancée après un
 * arrêt en route, elle refait le calcul entier, qui ne dépend que des lignes.
 *
 * Version 1 : le vocabulaire (`terms`) recalculé exactement. Trois temps, chacun par tranches qui
 * s'ajustent pour rester sous `WRITE_BUDGET_MS`, la main rendue entre deux : les répliques lues par
 * identifiant croissant et leurs mots comptés en mémoire (~130 000 mots) ; le vocabulaire parcouru
 * dans l'ordre, chaque compte faux corrigé, chaque mot sans réplique retiré ; les mots manquants
 * ajoutés. Le vocabulaire n'est jamais vidé : une recherche pendant la réparation lit des comptes
 * déjà justes ou encore faux, jamais une table vide.
 *
 * **Personne d'autre n'écrit pendant ce temps** : le comptage s'étale sur plusieurs secondes, et une
 * ligne écrite au milieu serait comptée deux fois ou pas du tout. C'est le moteur qui le garantit —
 * une passe attend la fin de la réparation avant de préparer quoi que ce soit (`engine.ts`).
 */
export async function repairIndex(): Promise<RepairReport | null> {
  const conn = repliquesDb();
  const done = readMeta<{ version: number }>(REPAIR_KEY);
  if (done && done.version >= REPAIR_VERSION) return null;
  const started = performance.now();
  let slices = 0;
  let maxSliceMs = 0;
  let busyMs = 0;
  const timed = <T>(fn: () => T): { value: T; ms: number } => {
    const t0 = performance.now();
    const value = fn();
    const ms = performance.now() - t0;
    slices++;
    busyMs += ms;
    if (ms > maxSliceMs) maxSliceMs = ms;
    noteSlice(ms);
    return { value, ms };
  };
  const adapt = (size: number, ms: number, max: number) =>
    ms < WRITE_BUDGET_MS / 3 ? Math.min(max, Math.ceil(size * 1.5)) : ms > WRITE_BUDGET_MS / 2 ? Math.max(50, Math.floor(size / 2)) : size;

  // 1. Compter les mots des répliques stockées.
  const counts = new Map<string, number>();
  const read = conn.prepare("SELECT id, norm FROM lines WHERE id > ? ORDER BY id LIMIT ?");
  let cursor = 0;
  let lines = 0;
  let totalAfter = 0;
  for (let size = 1000; ; ) {
    const { value: n, ms } = timed(() => {
      const rows = read.all(cursor, size) as { id: number; norm: string }[];
      for (const r of rows) {
        for (const word of r.norm.split(" ")) {
          if (!word) continue;
          counts.set(word, (counts.get(word) ?? 0) + 1);
          totalAfter++;
        }
      }
      if (rows.length > 0) cursor = rows[rows.length - 1].id;
      return rows.length;
    });
    lines += n;
    if (n < size) break;
    size = adapt(size, ms, 20_000);
    await yieldToLoop();
  }

  // 2. Le vocabulaire dans l'ordre : comptes corrigés, mots orphelins retirés.
  const readTerms = conn.prepare("SELECT term, n FROM terms WHERE term > ? ORDER BY term LIMIT ?");
  const fix = conn.prepare("UPDATE terms SET n = ? WHERE term = ?");
  const drop = conn.prepare("DELETE FROM terms WHERE term = ?");
  let terms = 0;
  let totalBefore = 0;
  let fixed = 0;
  let removed = 0;
  const compare = conn.transaction((after: string, size: number) => {
    const rows = readTerms.all(after, size) as { term: string; n: number }[];
    for (const r of rows) {
      terms++;
      totalBefore += r.n;
      const real = counts.get(r.term);
      if (real === undefined) {
        drop.run(r.term);
        removed++;
        continue;
      }
      if (real !== r.n) {
        fix.run(real, r.term);
        fixed++;
      }
      counts.delete(r.term);
    }
    return rows.length > 0 ? rows[rows.length - 1].term : null;
  });
  let after = "";
  for (let size = 500; ; ) {
    const { value: last, ms } = timed(() => compare(after, size));
    if (last === null) break;
    after = last;
    size = adapt(size, ms, 5000);
    await yieldToLoop();
  }

  // 3. Les mots qu'aucune ligne du vocabulaire ne portait.
  const missing = [...counts];
  const add = conn.prepare("INSERT INTO terms (term, n) VALUES (?, ?) ON CONFLICT(term) DO UPDATE SET n = excluded.n");
  const insert = conn.transaction((part: readonly [string, number][]) => {
    for (const [term, n] of part) add.run(term, n);
  });
  for (let at = 0, size = 500; at < missing.length; ) {
    const part = missing.slice(at, at + size);
    const { ms } = timed(() => insert(part));
    at += part.length;
    size = adapt(size, ms, 5000);
    await yieldToLoop();
  }

  const report: RepairReport = {
    version: REPAIR_VERSION,
    at: Date.now(),
    lines,
    terms,
    fixed,
    removed,
    added: missing.length,
    totalBefore,
    totalAfter,
    slices,
    maxSliceMs: Math.round(maxSliceMs * 10) / 10,
    busyMs: Math.round(busyMs),
    elapsedMs: Math.round(performance.now() - started),
  };
  writeMeta(REPAIR_KEY, report);
  return report;
}
