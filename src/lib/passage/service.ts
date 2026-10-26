import { createHash, randomBytes } from "node:crypto";
import { createSessionToken, decryptSecret, encryptSecret, type Role, type SessionPayload } from "@/lib/auth";
import { getDb, pushDb, sessionDb } from "@/lib/db";
import { config } from "@/lib/config";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { passJellyfinFetch } from "@/lib/jellyfinBreaker";
import { isJellyfinId, jellyfinIdSegment } from "@/lib/jellyfinPath";
import { cleanPassageSettings, type PassageSettings } from "./settings";
import { cleanPassageDownloads, type PassageDownload } from "./downloads";

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
 * appelé à chaque demande et à chaque échange, comme `sessionDb.create` fait le sien.
 */
export function prunePassages(now = Date.now()): void {
  const db = getDb();
  db.prepare("DELETE FROM passages WHERE rowid IN (SELECT rowid FROM passages WHERE expires_at < ? LIMIT 500)").run(now);
  db.prepare("DELETE FROM passage_arrivals WHERE rowid IN (SELECT rowid FROM passage_arrivals WHERE created_at < ? LIMIT 500)").run(now - PASSAGE_ARRIVAL_TTL_MS);
}

export async function createPassage(
  session: SessionPayload,
  input: { settings?: unknown; pushEndpoint?: unknown; downloads?: unknown },
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
  // Les téléchargements de ce compte sur cet appareil — la liste seulement, revalidée et bornée.
  const downloads = cleanPassageDownloads(input.downloads);
  const downloadsJson = downloads.length ? JSON.stringify(downloads) : null;

  const db = getDb();
  const insert = db.prepare(
    "INSERT INTO passages (hash, kind, user_id, origin_jti, sealed, settings, push_endpoint, downloads, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)"
  );
  db.transaction(() => {
    // Une nouvelle demande remplace les précédentes de cette session : un seul code valable à la fois.
    db.prepare("DELETE FROM passages WHERE origin_jti = ? AND used_at IS NULL").run(session.jti);
    insert.run(hashSecret("token", token), "token", session.u, session.jti, sealed, settingsJson, endpoint, downloadsJson, now, tokenExpiresAt);
    insert.run(hashSecret("code", code), "code", session.u, session.jti, sealed, settingsJson, endpoint, downloadsJson, now, codeExpiresAt);
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
  /** Le passage emporte des téléchargements : l'aide d'installation le dit (§119). */
  downloads: boolean;
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
  // Le ménage à l'échange aussi, pas seulement à la demande : une installation où l'on essaie des
  // codes sans plus rien demander gardait ses lignes expirées. Il n'efface que ce qui a expiré —
  // l'écriture conditionnelle ci-dessous ne l'aurait de toute façon pas servi.
  prunePassages(now);
  const row = db
    .prepare("UPDATE passages SET used_at = ? WHERE hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ? RETURNING origin_jti, sealed, settings, push_endpoint, downloads")
    .get(now, hashSecret(kind, secret), kind, now) as
    | { origin_jti: string; sealed: string; settings: string | null; push_endpoint: string | null; downloads: string | null }
    | undefined;
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
  // Toujours une ligne d'arrivée, même sans réglages : elle porte la session d'origine
  // (`origin_jti`), d'où l'ancienne adresse apprend ce que celle-ci a récupéré (`passageFetchedFor`)
  // — et les téléchargements emportés, à proposer une fois.
  db.prepare(
    "INSERT OR REPLACE INTO passage_arrivals (jti, user_id, settings, push_endpoint, downloads, origin_jti, fetched, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)"
  ).run(jti, sealed.u, row.settings, row.push_endpoint, row.downloads, row.origin_jti, now);
  return { token, jti, role: sealed.role, user: sealed.jfUser ?? sealed.u, userId: origin.userId, expiredDevices, downloads: !!row.downloads };
}

/**
 * Ce qu'une session d'arrivée doit encore poser sur son appareil, et la date de l'arrivée : les
 * réglages, et la liste des téléchargements emportés — non filtrée : `availablePassageItems` en
 * retire ce que le compte ne voit plus avant de la montrer. `null` s'il ne reste rien.
 */
export function passageArrival(jti: string): { at: number; settings?: PassageSettings; downloads?: PassageDownload[] } | null {
  const row = getDb().prepare("SELECT settings, downloads, created_at FROM passage_arrivals WHERE jti = ?").get(jti) as
    | { settings: string | null; downloads: string | null; created_at: number }
    | undefined;
  if (!row) return null;
  const parse = (value: string | null): unknown => {
    try {
      return value ? (JSON.parse(value) as unknown) : null;
    } catch {
      return null;
    }
  };
  const settings = row.settings ? cleanPassageSettings(parse(row.settings)) : null;
  const downloads = row.downloads ? cleanPassageDownloads(parse(row.downloads)) : [];
  if (!settings && !downloads.length) return null;
  return { at: row.created_at, ...(settings ? { settings } : {}), ...(downloads.length ? { downloads } : {}) };
}

/**
 * Posé sur l'appareil. Les réglages : dans l'application installée, c'est fini, ils sont effacés ;
 * dans un onglet, ils restent (au plus `PASSAGE_ARRIVAL_TTL_MS`) — sur Android et sur ordinateur,
 * l'application installée ensuite partage la session de l'onglet et les posera à son tour.
 * Les téléchargements : effacés dès qu'un appareil les a pris (`downloads: true`) — proposés une
 * seule fois ; le navigateur garde l'invitation de son côté jusqu'à ce qu'on la ferme.
 */
export function ackPassageArrival(jti: string, installed: boolean, taken: { settings?: boolean; downloads?: boolean } = {}): void {
  const db = getDb();
  if (installed && taken.settings !== false) db.prepare("UPDATE passage_arrivals SET settings = NULL WHERE jti = ?").run(jti);
  if (taken.downloads === true) db.prepare("UPDATE passage_arrivals SET downloads = NULL WHERE jti = ?").run(jti);
}

/** Au plus tant de titres notés récupérés par une même arrivée. */
const FETCHED_MAX = 200;

/**
 * Une session venue d'un passage vient de recevoir la dernière plage d'une version hors ligne finie
 * (`/api/offline/jobs/<id>/file`) : noté sur sa ligne d'arrivée, titre → version. C'est la preuve
 * qu'attend l'ancienne adresse pour effacer ses propres fichiers (`passageFetchedFor`) : servie par
 * le serveur, à ce compte, à une session de la nouvelle adresse (son cookie n'existe que là) issue du
 * passage de cet appareil-là. Une session ordinaire n'a pas de ligne d'arrivée : une lecture par clé
 * primaire, rien d'écrit.
 *
 * Gardée à part de `offline_requests.fetched_at` exprès : cette ligne-là disparaît avec la copie du
 * serveur, cinq minutes après la dernière plage (`releaseFetchedCopies`), et elle est commune à tous
 * les appareils du compte — elle ne dit ni d'où, ni quand l'ancienne adresse rouvrira.
 */
export function notePassageFetched(jti: string, user: string, itemId: string, jobId: string): void {
  const db = getDb();
  const row = db.prepare("SELECT fetched FROM passage_arrivals WHERE jti = ? AND user_id = ? AND origin_jti IS NOT NULL").get(jti, user) as
    | { fetched: string | null }
    | undefined;
  if (!row) return;
  let fetched: Record<string, string> = {};
  try {
    const parsed = row.fetched ? (JSON.parse(row.fetched) as unknown) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fetched = parsed as Record<string, string>;
  } catch {
    fetched = {};
  }
  if (fetched[itemId] === jobId) return;
  delete fetched[itemId];
  fetched[itemId] = jobId;
  const keys = Object.keys(fetched);
  for (const key of keys.slice(0, Math.max(0, keys.length - FETCHED_MAX))) delete fetched[key];
  db.prepare("UPDATE passage_arrivals SET fetched = ? WHERE jti = ?").run(JSON.stringify(fetched), jti);
}

/**
 * Parmi ces titres, ceux que **ce compte** a récupérés entiers sur la nouvelle adresse, par une
 * session issue d'un passage parti de **cette session** (`originJti` : celle de l'appareil qui
 * demande) — titre → version récupérée. Un autre compte, une autre session (un autre appareil du
 * même compte) n'ont aucune arrivée issue de celle-ci : ils n'apprennent rien.
 */
/**
 * La session qui demande est-elle passée — un de ses passages a-t-il ouvert une session sur la nouvelle
 * adresse (`passage_arrivals.origin_jti`) ? L'ancienne adresse en déduit que ses téléchargements
 * inachevés ne serviront plus (26/10/2026) : la nouvelle repart de zéro, elle a son propre stockage.
 */
export function passageArrivedFrom(originJti: string, user: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM passage_arrivals WHERE origin_jti = ? AND user_id = ? LIMIT 1").get(originJti, user);
}

export function passageFetchedFor(originJti: string, user: string, itemIds: readonly string[]): Record<string, string> {
  const rows = getDb().prepare("SELECT fetched FROM passage_arrivals WHERE origin_jti = ? AND user_id = ? AND fetched IS NOT NULL").all(originJti, user) as {
    fetched: string;
  }[];
  const wanted = new Set(itemIds);
  const out: Record<string, string> = {};
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.fetched) as Record<string, unknown>;
      for (const [itemId, jobId] of Object.entries(parsed)) if (wanted.has(itemId) && typeof jobId === "string") out[itemId] = jobId;
    } catch {
      /* ligne abîmée : elle n'atteste rien */
    }
  }
  return out;
}

/**
 * Parmi ces titres, ceux que ce compte voit encore : une seule question à Jellyfin, **sous son
 * identité** (`/Users/{jfId}/Items?Ids=`) — Jellyfin y applique lui-même ses droits, son contrôle
 * parental et les tags bloqués du compte (§54), sans copie des règles ici ; un titre supprimé n'y est
 * plus. Le compte administrateur local, sans identité Jellyfin, n'apprend que l'existence. `null` :
 * Jellyfin n'a pas répondu — rien n'est montré, l'arrivée reposera la question au lancement suivant.
 */
export async function availablePassageItems(session: Pick<SessionPayload, "role" | "jfId">, itemIds: readonly string[]): Promise<Set<string> | null> {
  const ids = itemIds.filter((id) => isJellyfinId(id));
  if (!ids.length) return new Set();
  if (session.role !== "admin" && session.role !== "user") return new Set();
  if (!session.jfId && session.role !== "admin") return new Set();
  try {
    const base = session.jfId ? `${config.jellyfin.url}/Users/${jellyfinIdSegment(session.jfId)}/Items` : `${config.jellyfin.url}/Items`;
    const res = await passJellyfinFetch(`${base}?Ids=${ids.map((id) => jellyfinIdSegment(id)).join(",")}&EnableImages=false&EnableUserData=false`, {
      headers: jellyfinAuthHeaders(config.jellyfin.apiKey),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      return res.status >= 400 && res.status < 500 ? new Set() : null;
    }
    const page = (await res.json()) as { Items?: { Id?: string }[] };
    const seen = new Set((page.Items ?? []).map((i) => (i.Id ?? "").replace(/-/g, "").toLowerCase()));
    return new Set(ids.filter((id) => seen.has(id.toLowerCase())));
  } catch {
    return null;
  }
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
