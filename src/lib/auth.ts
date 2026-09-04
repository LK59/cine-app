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
  const payload: SessionPayload = {
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
  const encodedPayload = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await sign(encodedPayload);
  return { token: `${encodedPayload}.${signature}`, jti };
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
    return payload;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = COOKIE_NAME;
export const SESSION_MAX_AGE = MAX_AGE_SECONDS;
