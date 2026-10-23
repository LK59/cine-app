import { createHash, randomBytes } from "node:crypto";
import { createSessionToken, decryptSecret, encryptSecret, type Role, type SessionPayload } from "@/lib/auth";
import { getDb, pushDb, sessionDb } from "@/lib/db";
import { cleanPassageSettings, type PassageSettings } from "./settings";

/**
 * Le passage d'une adresse à l'autre, en un appui (DECISIONS.md §119).
 *
 * Une session vivante du foyer demande un passage ; le serveur rend deux secrets, chacun à usage
 * unique et rangé haché :
 *  - le **jeton** (32 octets, deux minutes), mis dans le fragment de l'adresse qu'ouvre l'appui —
 *    ni le proxy ni aucun journal ne voient un fragment ;
 *  - le **code** (8 caractères, quinze minutes), à recopier là où le jeton ne suit pas : une
 *    application installée sur iPhone a son propre stockage, sans les cookies de Safari.
 * Présenté sur la nouvelle adresse, l'un ou l'autre ouvre une session **jumelle** de celle d'origine
 * — même compte, même rôle, même jeton Jellyfin et même appareil Jellyfin, nouveau `jti`. L'appareil
 * partagé ne tombe qu'avec la dernière des deux sessions (`orphanDevices`, db.ts) : se déconnecter
 * d'une adresse ne coupe pas l'autre.
 *
 * Une session révoquée entre la demande et l'échange invalide ses secrets : l'échange vérifie que la
 * session d'origine existe encore.
 */

export const PASSAGE_TOKEN_TTL_MS = 2 * 60_000;
export const PASSAGE_CODE_TTL_MS = 15 * 60_000;
/** Les réglages et l'abonnement à remplacer, gardés avec la session d'arrivée au plus ce temps. */
export const PASSAGE_ARRIVAL_TTL_MS = 30 * 24 * 3600_000;

/** Crockford base32 : ni I, L, O, U — rien qui se confonde à la lecture ou à la dictée. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

export type PassageKind = "token" | "code";

function hashSecret(kind: PassageKind, secret: string): string {
  return createHash("sha256").update(`${kind}:${secret}`).digest("hex");
}

export function generatePassageCode(): string {
  // 256 est un multiple de 32 : `octet & 31` est uniforme, sans rejet.
  return [...randomBytes(CODE_LENGTH)].map((b) => CODE_ALPHABET[b & 31]).join("");
}

/** « abcd-efgh », « ABCD EFGH », un O pour un 0 : la forme canonique, ou `null`. */
export function normalizePassageCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 32) return null;
  const code = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (code.length !== CODE_LENGTH) return null;
  return [...code].every((c) => CODE_ALPHABET.includes(c)) ? code : null;
}

/** Le jeton tel qu'il voyage : 43 caractères base64url. */
export function isPassageToken(input: unknown): input is string {
  return typeof input === "string" && /^[A-Za-z0-9_-]{43}$/.test(input);
}

/** Ce que la session d'arrivée reprend de celle d'origine — chiffré en base (`encryptSecret`). */
interface SealedSession {
  u: string;
  role: Role;
  jfUser?: string;
  jfId?: string;
  jfToken?: string;
  jsCookie?: string;
}

export type CreatePassageResult =
  | { ok: true; token: string; code: string; tokenExpiresAt: number; codeExpiresAt: number }
  | { ok: false; reason: "forbidden" | "relogin" };

/**
 * Le ménage : les secrets expirés (utilisés ou non) et les arrivées trop vieilles, par lots bornés —
 * appelé à chaque demande, comme `sessionDb.create` fait le sien.
 */
export function prunePassages(now = Date.now()): void {
  const db = getDb();
  db.prepare("DELETE FROM passages WHERE rowid IN (SELECT rowid FROM passages WHERE expires_at < ? LIMIT 500)").run(now);
  db.prepare("DELETE FROM passage_arrivals WHERE rowid IN (SELECT rowid FROM passage_arrivals WHERE created_at < ? LIMIT 500)").run(now - PASSAGE_ARRIVAL_TTL_MS);
}

export async function createPassage(
  session: SessionPayload,
  input: { settings?: unknown; pushEndpoint?: unknown },
  now = Date.now()
): Promise<CreatePassageResult> {
  // Le foyer seulement : un lien de partage ne voyage pas (§112) — et la porte des liens le refuse
  // déjà avant d'arriver ici.
  if (session.role !== "admin" && session.role !== "user") return { ok: false, reason: "forbidden" };
  const origin = sessionDb.get(session.jti);
  if (!origin) return { ok: false, reason: "forbidden" };
  // Une session ouverte avant qu'on garde son appareil Jellyfin (24/09/2026) ne sait se fermer chez
  // Jellyfin que par son jeton : partagé, il tomberait pour les deux adresses à la première
  // déconnexion. Une reconnexion lui donne un appareil.
  if (session.jfToken && !origin.jfDevice) return { ok: false, reason: "relogin" };

  const settings: PassageSettings = cleanPassageSettings(input.settings);
  // L'abonnement de cet appareil sur l'ancienne adresse, s'il est bien rangé sous ce compte : seul
  // celui-là pourra être retiré à l'arrivée.
  const endpoint =
    typeof input.pushEndpoint === "string" && input.pushEndpoint.length <= 1024 && pushDb.getByUser(session.u).some((s) => s.endpoint === input.pushEndpoint)
      ? input.pushEndpoint
      : null;

  const sealedSession: SealedSession = {
    u: session.u,
    role: session.role,
    ...(session.jfUser ? { jfUser: session.jfUser } : {}),
    ...(session.jfId ? { jfId: session.jfId } : {}),
    ...(session.jfToken ? { jfToken: session.jfToken } : {}),
    ...(session.jsCookie ? { jsCookie: session.jsCookie } : {}),
  };
  const sealed = await encryptSecret(JSON.stringify(sealedSession));
  const token = randomBytes(32).toString("base64url");
  const code = generatePassageCode();
  const tokenExpiresAt = now + PASSAGE_TOKEN_TTL_MS;
  const codeExpiresAt = now + PASSAGE_CODE_TTL_MS;
  const settingsJson = Object.keys(settings).length ? JSON.stringify(settings) : null;

  const db = getDb();
  const insert = db.prepare(
    "INSERT INTO passages (hash, kind, user_id, origin_jti, sealed, settings, push_endpoint, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)"
  );
  db.transaction(() => {
    // Une nouvelle demande remplace les précédentes de cette session : un seul code valable à la fois.
    db.prepare("DELETE FROM passages WHERE origin_jti = ? AND used_at IS NULL").run(session.jti);
    insert.run(hashSecret("token", token), "token", session.u, session.jti, sealed, settingsJson, endpoint, now, tokenExpiresAt);
    insert.run(hashSecret("code", code), "code", session.u, session.jti, sealed, settingsJson, endpoint, now, codeExpiresAt);
  })();
  prunePassages(now);
  return { ok: true, token, code, tokenExpiresAt, codeExpiresAt };
}

export interface RedeemedPassage {
  token: string;
  jti: string;
  role: Role;
  user: string;
  /** La clé du compte dans `sessions` et `user_preferences` — celle de la session d'origine. */
  userId: string;
  /** Les appareils Jellyfin des sessions expirées effacées au passage, à révoquer. */
  expiredDevices: string[];
}

/**
 * Échange un secret contre une session. `null` pour tout refus — inexistant, expiré, déjà servi,
 * session d'origine fermée — sans dire lequel.
 *
 * Le secret est consommé avant tout le reste, par une seule écriture conditionnelle : deux
 * présentations simultanées ne peuvent pas réussir toutes les deux.
 */
export async function redeemPassage(kind: PassageKind, secret: string, device: string | null, now = Date.now()): Promise<RedeemedPassage | null> {
  const db = getDb();
  const row = db
    .prepare("UPDATE passages SET used_at = ? WHERE hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ? RETURNING origin_jti, sealed, settings, push_endpoint")
    .get(now, hashSecret(kind, secret), kind, now) as { origin_jti: string; sealed: string; settings: string | null; push_endpoint: string | null } | undefined;
  if (!row) return null;
  const origin = sessionDb.get(row.origin_jti);
  if (!origin) return null;
  let sealed: SealedSession;
  try {
    sealed = JSON.parse((await decryptSecret(row.sealed)) ?? "null") as SealedSession;
  } catch {
    return null;
  }
  if (!sealed || typeof sealed.u !== "string" || (sealed.role !== "admin" && sealed.role !== "user")) return null;

  const { token, jti } = await createSessionToken(sealed.u, sealed.role, sealed.jfUser, sealed.jfId, sealed.jfToken, sealed.jsCookie);
  const expiredDevices = sessionDb.create(jti, origin.userId, device, origin.jfDevice);
  if (row.settings || row.push_endpoint) {
    db.prepare("INSERT OR REPLACE INTO passage_arrivals (jti, user_id, settings, push_endpoint, created_at) VALUES (?, ?, ?, ?, ?)").run(
      jti,
      sealed.u,
      row.settings,
      row.push_endpoint,
      now
    );
  }
  return { token, jti, role: sealed.role, user: sealed.jfUser ?? sealed.u, userId: origin.userId, expiredDevices };
}

/** Les réglages qu'une session d'arrivée doit encore poser sur son appareil, et leur date. */
export function passageArrival(jti: string): { at: number; settings: PassageSettings } | null {
  const row = getDb().prepare("SELECT settings, created_at FROM passage_arrivals WHERE jti = ?").get(jti) as
    | { settings: string | null; created_at: number }
    | undefined;
  if (!row?.settings) return null;
  try {
    return { at: row.created_at, settings: cleanPassageSettings(JSON.parse(row.settings)) };
  } catch {
    return null;
  }
}

/**
 * Les réglages ont été posés. Dans l'application installée, c'est fini : ils sont effacés. Dans un
 * onglet, ils restent (au plus `PASSAGE_ARRIVAL_TTL_MS`) — sur Android et sur ordinateur,
 * l'application installée ensuite partage la session de l'onglet et les posera à son tour.
 */
export function ackPassageArrival(jti: string, installed: boolean): void {
  if (!installed) return;
  getDb().prepare("UPDATE passage_arrivals SET settings = NULL WHERE jti = ?").run(jti);
}

/**
 * L'appareil arrivé vient de s'abonner aux notifications sur la nouvelle adresse : l'abonnement de
 * l'ancienne, emporté par le passage, est retiré — **de ce compte seulement** (`removeForUser`), et
 * jamais le nouveau. Plus de double réception. Rend vrai si quelque chose a été retiré.
 */
export function replaceArrivedPushEndpoint(jti: string, user: string, newEndpoint: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT push_endpoint FROM passage_arrivals WHERE jti = ? AND user_id = ?").get(jti, user) as
    | { push_endpoint: string | null }
    | undefined;
  const old = row?.push_endpoint;
  if (!old || old === newEndpoint) return false;
  const before = pushDb.countForUser(user);
  pushDb.removeForUser(user, old);
  // Les autres arrivées de ce compte qui portaient le même ancien abonnement : il n'existe plus.
  db.prepare("UPDATE passage_arrivals SET push_endpoint = NULL WHERE user_id = ? AND push_endpoint = ?").run(user, old);
  return pushDb.countForUser(user) < before;
}
