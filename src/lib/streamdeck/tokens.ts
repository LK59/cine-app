import crypto from "node:crypto";
import { getDb } from "@/lib/db";

/**
 * Les jetons du Stream Deck (27/10/2026) : ce que le plugin présente à la place d'une session.
 *
 * Un Stream Deck n'a pas de cookie, et la session d'un administrateur ouvre tout : lui en confier une
 * aurait mis l'interface entière dans un fichier de réglages sur un ordinateur. Le jeton n'ouvre que
 * les deux routes de `/api/streamdeck/` — les lectures en cours et leurs affiches —, en lecture seule ;
 * il se crée et se révoque appareil par appareil depuis Configuration → Administration.
 *
 * Seule l'empreinte est gardée (SHA-256) : 32 octets aléatoires ne se devinent pas, un sel n'y
 * ajoute rien, et une copie de la base ne rend aucun jeton utilisable.
 */

const PREFIX = "ltn_sd_";
/** Le dernier usage n'est réécrit qu'une fois par minute : le plugin interroge toutes les quelques secondes. */
const TOUCH_EVERY_MS = 60_000;
/** Assez pour un appareil par pièce ; une liste qui grossit sans fin serait un oubli de révocation. */
export const MAX_TOKENS = 10;

export interface StreamDeckToken {
  id: string;
  name: string;
  createdBy: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface Row {
  id: string;
  name: string;
  created_by: string;
  created_at: number;
  last_used_at: number | null;
}

const hashOf = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export function listStreamDeckTokens(): StreamDeckToken[] {
  const rows = getDb().prepare("SELECT id, name, created_by, created_at, last_used_at FROM streamdeck_tokens ORDER BY created_at").all() as Row[];
  return rows.map((r) => ({ id: r.id, name: r.name, createdBy: r.created_by, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
}

/** Un jeton neuf : rendu ici une seule fois, jamais relisible ensuite. `null` au-delà de `MAX_TOKENS`. */
export function createStreamDeckToken(name: string, createdBy: string, now = Date.now()): { token: string; id: string } | null {
  const db = getDb();
  const count = (db.prepare("SELECT COUNT(*) AS n FROM streamdeck_tokens").get() as { n: number }).n;
  if (count >= MAX_TOKENS) return null;
  const id = crypto.randomBytes(8).toString("hex");
  const token = PREFIX + crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO streamdeck_tokens (id, name, hash, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(id, name, hashOf(token), createdBy, now);
  return { token, id };
}

export function revokeStreamDeckToken(id: string): boolean {
  return getDb().prepare("DELETE FROM streamdeck_tokens WHERE id = ?").run(id).changes > 0;
}

/**
 * Le jeton d'une requête (`Authorization: Bearer …`), s'il est connu : son identifiant, sinon `null`.
 * La recherche se fait par empreinte — rien n'est comparé caractère par caractère.
 */
export function verifyStreamDeckToken(header: string | null, now = Date.now()): string | null {
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  const token = match?.[1];
  if (!token || !token.startsWith(PREFIX) || token.length > 200) return null;
  const db = getDb();
  const row = db.prepare("SELECT id, last_used_at FROM streamdeck_tokens WHERE hash = ?").get(hashOf(token)) as Pick<Row, "id" | "last_used_at"> | undefined;
  if (!row) return null;
  if (row.last_used_at === null || now - row.last_used_at >= TOUCH_EVERY_MS) {
    db.prepare("UPDATE streamdeck_tokens SET last_used_at = ? WHERE id = ?").run(now, row.id);
  }
  return row.id;
}
