import { config } from "@/lib/config";

const COOKIE_NAME = "cine_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

export type Role = "admin" | "user";

/**
 * Le rôle non-administrateur s'est appelé « guest » jusqu'au chantier du lecteur, et les jetons
 * déjà émis le portent encore. On les accepte donc en lecture et on les ramène à « user » : sans
 * ça, le renommage aurait déconnecté tout le monde d'un coup.
 */
const LEGACY_GUEST = "guest";

export interface SessionPayload {
  u: string;
  role: Role;
  exp: number;
  jti: string;       // Unique session ID — used for server-side revocation
  jfUser?: string;   // Jellyfin username — set when authenticated via Jellyfin SSO
  jfId?: string;     // Jellyfin user UUID — required for watch status operations
  jfToken?: string;  // Jellyfin access token — used for deep-link auth redirect
  jsCookie?: string; // Jellyseerr session cookie (connect.sid value) — this fork requires a real
                      // session for user-attributed actions (requests), the admin API key alone
                      // is no longer sufficient. Obtained by also logging into Jellyseerr with
                      // the same Jellyfin credentials at sign-in time (see /api/auth/jellyfin).
                      // Absent for the local-admin login (no Jellyfin identity to authenticate
                      // to Jellyseerr with) or if that login attempt failed.
}

function base64url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const str = atob(padded);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

async function getKey(): Promise<CryptoKey> {
  const secret = config.app.sessionSecret;
  if (secret === "change-me-in-production") {
    console.error("[auth] SESSION_SECRET not set — using insecure default. Set SESSION_SECRET in .env");
  }
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/**
 * La clé de chiffrement des secrets portés par le jeton, dérivée du même secret que la signature.
 *
 * Un condensé plutôt que le secret brut : `SESSION_SECRET` est une chaîne choisie à la main, de
 * longueur quelconque, et AES-GCM veut exactement 256 bits. Dériver évite d'imposer une contrainte
 * de longueur à la configuration, et de réutiliser tel quel un secret qui sert déjà à signer.
 */
async function getEncryptionKey(): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`enc:${config.app.sessionSecret}`));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Le préfixe qui distingue un champ chiffré d'un champ écrit en clair par une version d'avant. */
const ENC_PREFIX = "v1:";

/**
 * Chiffrer un secret porté par le cookie.
 *
 * Le jeton d'accès Jellyfin et la session Jellyseerr voyagent dans le cookie. Signés, ils ne
 * peuvent pas être falsifiés — mais signer n'est pas cacher : la charge utile est du base64, et
 * quiconque met la main sur le cookie repartait avec un jeton Jellyfin utilisable, pas seulement
 * avec une session Cine App. Le cookie est `httpOnly`, donc hors de portée du JavaScript ; il
 * reste les machines partagées, les journaux de proxy et les sauvegardes de profil.
 */
async function encryptField(value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await getEncryptionKey();
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  return `${ENC_PREFIX}${base64url(iv)}.${base64url(cipher)}`;
}

/**
 * Déchiffrer, ou rendre tel quel.
 *
 * Les jetons émis avant ce changement portent ces champs en clair : les refuser aurait déconnecté
 * tout le monde d'un coup, et ils expirent d'eux-mêmes en une semaine. Un déchiffrement qui échoue
 * rend `undefined` plutôt que de faire tomber la session entière — on perd l'accès à Jellyseerr,
 * pas la connexion.
 */
async function decryptField(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  if (!value.startsWith(ENC_PREFIX)) return value;
  const [ivPart, cipherPart] = value.slice(ENC_PREFIX.length).split(".");
  if (!ivPart || !cipherPart) return undefined;
  try {
    const key = await getEncryptionKey();
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64url(ivPart) },
      key,
      fromBase64url(cipherPart)
    );
    return new TextDecoder().decode(plain);
  } catch {
    return undefined;
  }
}

async function sign(payload: string): Promise<string> {
  const key = await getKey();
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64url(sig);
}

function generateJti(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export async function createSessionToken(
  username: string,
  role: Role,
  jellyfinUser?: string,
  jellyfinId?: string,
  jellyfinToken?: string,
  jellyseerrCookie?: string
): Promise<{ token: string; jti: string }> {
  const jti = generateJti();
  return { token: await encodeSession(buildPayload(jti, username, role, jellyfinUser, jellyfinId, jellyfinToken, jellyseerrCookie)), jti };
}

/**
 * Réémettre le même jeton, plus loin dans le temps.
 *
 * Le `jti` est conservé, et c'est tout l'intérêt : une session qui se prolonge doit rester *la
 * même* session. En générer un nouveau à chaque prolongation ferait apparaître une session de plus
 * dans la liste à chaque jour d'usage, et « révoquer les autres » deviendrait « me déconnecter
 * partout, y compris de mon passé ».
 */
export async function refreshSessionToken(payload: SessionPayload): Promise<string> {
  return encodeSession({ ...payload, exp: Date.now() + MAX_AGE_SECONDS * 1000 });
}

/**
 * L'âge à partir duquel un jeton est réémis.
 *
 * Assez rare pour ne pas réécrire un cookie à chaque requête, assez fréquent pour qu'une personne
 * qui ouvre l'application tous les soirs ne soit jamais déconnectée. Sans ça, tout le monde était
 * déconnecté sept jours après sa connexion, quelle que soit son activité.
 */
export const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

/** Ce jeton a-t-il assez vieilli pour valoir une réémission. */
export function shouldRefresh(payload: SessionPayload): boolean {
  const issuedAt = payload.exp - MAX_AGE_SECONDS * 1000;
  return Date.now() - issuedAt > SESSION_REFRESH_AFTER_MS;
}

function buildPayload(
  jti: string,
  username: string,
  role: Role,
  jellyfinUser?: string,
  jellyfinId?: string,
  jellyfinToken?: string,
  jellyseerrCookie?: string
): SessionPayload {
  return {
    u: username,
    role,
    exp: Date.now() + MAX_AGE_SECONDS * 1000,
    jti,
    ...(jellyfinUser ? { jfUser: jellyfinUser } : {}),
    ...(jellyfinId ? { jfId: jellyfinId } : {}),
    ...(jellyfinToken ? { jfToken: jellyfinToken } : {}),
    // cine-app's own session (7 days, MAX_AGE_SECONDS above) is deliberately shorter than
    // Jellyseerr's own cookie lifetime (30 days, confirmed in seerr's own session middleware
    // config) — a cine-app session can never legitimately outlive the Jellyseerr cookie it
    // carries, so there's no expiry-mismatch case to handle: by the time this cookie could
    // expire, the user will already have had to sign into cine-app (and thus Jellyseerr) again.
    ...(jellyseerrCookie ? { jsCookie: jellyseerrCookie } : {}),
  };
}

/** Chiffre ce qui doit l'être, encode, signe. */
async function encodeSession(payload: SessionPayload): Promise<string> {
  const sealed: SessionPayload = {
    ...payload,
    ...(payload.jfToken ? { jfToken: await encryptField(payload.jfToken) } : {}),
    ...(payload.jsCookie ? { jsCookie: await encryptField(payload.jsCookie) } : {}),
  };
  const encodedPayload = base64url(new TextEncoder().encode(JSON.stringify(sealed)));
  return `${encodedPayload}.${await sign(encodedPayload)}`;
}

export async function verifySessionToken(
  token: string | undefined | null
): Promise<SessionPayload | null> {
  if (!token) return null;
  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) return null;
  const encodedPayload = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);
  if (!encodedPayload || !signature) return null;
  // Use crypto.subtle.verify for constant-time HMAC comparison
  const key = await getKey();
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64url(signature),
      new TextEncoder().encode(encodedPayload)
    );
  } catch {
    return null;
  }
  if (!valid) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(encodedPayload))) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp <= Date.now()) return null;
    if ((payload.role as string) === LEGACY_GUEST) payload.role = "user";
    if (payload.role !== "admin" && payload.role !== "user") return null;
    payload.jfToken = await decryptField(payload.jfToken);
    payload.jsCookie = await decryptField(payload.jsCookie);
    return payload;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = COOKIE_NAME;
export const SESSION_MAX_AGE = MAX_AGE_SECONDS;
