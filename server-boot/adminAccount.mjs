// Le mot de passe du compte administrateur créé par l'assistant (DECISIONS.md §48) : son hachage,
// sa vérification, et sa réinitialisation hors de l'application.
//
// Un seul module pour les trois, lu par l'application (`src/lib/settings/setup.ts`) et par la
// commande `reset-admin-password.mjs` : une réinitialisation qui hacherait autrement que la
// connexion ne vérifie fabriquerait un mot de passe que personne ne peut plus saisir.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ADMIN_USER_KEY = "__ADMIN_USER";
export const ADMIN_HASH_KEY = "__ADMIN_PASSWORD_HASH";
export const MIN_ADMIN_PASSWORD = 8;

function scrypt(password, salt) {
  return crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
}

/** `scrypt$<sel>$<hachage>`, sel aléatoire de 16 octets. */
export function hashAdminPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scrypt(password, salt).toString("hex")}`;
}

/** Comparaison à temps constant ; un hachage illisible ne vérifie rien. */
export function verifyAdminPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored ?? "").split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const actual = scrypt(password, Buffer.from(saltHex, "hex"));
  const expected = Buffer.from(hashHex, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * Pose un nouveau mot de passe directement dans la base, application arrêtée ou non (SQLite en WAL
 * accepte une seconde connexion). Le nom du compte est gardé, sauf si `user` en donne un. Rend le
 * nom du compte.
 */
export async function resetAdminPassword(dataDir, password, user) {
  if (typeof password !== "string" || password.length < MIN_ADMIN_PASSWORD) {
    throw new Error(`le mot de passe doit faire au moins ${MIN_ADMIN_PASSWORD} caractères`);
  }
  const { default: Database } = await import("better-sqlite3");
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "cine.db"));
  try {
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    const write = db.prepare(
      "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    );
    const current = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(ADMIN_USER_KEY)?.value;
    const name = user || current || "admin";
    db.transaction(() => {
      write.run(ADMIN_USER_KEY, name);
      write.run(ADMIN_HASH_KEY, hashAdminPassword(password));
    })();
    return name;
  } finally {
    db.close();
  }
}
