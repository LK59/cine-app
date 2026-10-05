import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir";

/**
 * Les réglages faits dans l'application, gardés dans la base (DECISIONS.md §48).
 *
 * Sa propre connexion à `cine.db`, et rien d'autre de l'application : `config.ts` le lit, et
 * passer par `db.ts` — qui importe d'autres modules — aurait ouvert une boucle d'imports. SQLite en
 * WAL accepte plusieurs connexions.
 *
 * Une table clé/valeur. Une clé présente l'emporte sur `.env` ; l'effacer rend la main à `.env`
 * (« revenir à la valeur du .env »). Les clés internes commencent par `__` (le drapeau de
 * l'assistant, le mot de passe administrateur créé à l'assistant).
 *
 * Lu souvent (chaque appel d'un service relit sa configuration), donc gardé deux secondes en
 * mémoire : le proxy et les routes ne partagent pas forcément le même module, et deux secondes est
 * le plus long qu'un réglage changé ailleurs mette à s'appliquer. Une base illisible ne fait jamais
 * tomber la configuration : on retombe sur `.env`.
 */

let connection: Database.Database | null = null;
let unavailable = false;

function open(): Database.Database | null {
  if (connection || unavailable) return connection;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    connection = new Database(path.join(DATA_DIR, "cine.db"));
    connection.pragma("journal_mode = WAL");
    connection.exec(`CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  } catch {
    unavailable = true;
    connection = null;
  }
  return connection;
}

const TTL_MS = 2000;
let cache: Map<string, string> | null = null;
let cachedAt = 0;

function all(): Map<string, string> {
  const now = Date.now();
  if (cache && now - cachedAt < TTL_MS) return cache;
  const db = open();
  if (!db) return cache ?? new Map();
  try {
    const rows = db.prepare("SELECT key, value FROM app_settings").all() as { key: string; value: string }[];
    cache = new Map(rows.map((r) => [r.key, r.value]));
    cachedAt = now;
  } catch {
    cache ??= new Map();
  }
  return cache;
}

/** La valeur réglée dans l'application, ou `null`. */
export function readOverride(key: string): string | null {
  return all().get(key) ?? null;
}

export function writeOverride(key: string, value: string): void {
  const db = open();
  if (!db) throw new Error("La base des réglages est indisponible.");
  db.prepare(
    "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(key, value);
  cache = null;
}

export function deleteOverride(key: string): void {
  const db = open();
  if (!db) throw new Error("La base des réglages est indisponible.");
  db.prepare("DELETE FROM app_settings WHERE key = ?").run(key);
  cache = null;
}

/** Pour les tests : oublier la connexion (un autre `DATA_DIR`). */
export function resetSettingsStoreForTests(): void {
  try {
    connection?.close();
  } catch {
    /* déjà fermée */
  }
  connection = null;
  unavailable = false;
  cache = null;
}
