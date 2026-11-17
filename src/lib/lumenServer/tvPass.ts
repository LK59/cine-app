// Le laissez-passer d'une Apple TV pour Lumen serveur (étape 4b de docs/remux-serveur/, DECISIONS.md §186).
//
// En AirPlay, Safari ne diffuse pas l'image : il tend au téléviseur **l'adresse** de l'élément, et l'Apple TV va
// chercher la liste maître, les listes et chaque segment elle-même — sans notre cookie, et sans moyen d'en avoir un.
// Le lecteur serveur le règle par `castToken` en paramètre de requête, recopié dans chaque ligne des listes de
// Jellyfin (`withCastPass`). Ici, le jeton est **dans le chemin**, juste avant le nom :
//
//   /api/lumen/{itemId}/{version}/{s}/tv.{jeton}/master.m3u8
//
// et les listes de Lumen serveur n'ont que des URI relatives (`v.m3u8`, `init-v.mp4`, `v/12.m4s`) : chacune se résout
// sous `…/tv.{jeton}/` (rfc8216bis §4.1), et l'Apple TV le reporte d'elle-même sur toutes ses requêtes, sans une ligne
// réécrite (2-serveur.md §2.3).
//
// **Un autre jeton que `castToken`, exprès.** Les mêmes bornes (un titre, la session vivante, six heures), plus trois :
// - **sa propre clé** (dérivée de `SESSION_SECRET` avec le préfixe `lumen-tv:`) : un `castToken` n'ouvre pas Lumen
//   serveur, et un laissez-passer Lumen n'ouvre pas le flux Jellyfin — leurs signatures ne se valent pas, même si les
//   deux formats venaient à se ressembler ;
// - **sa portée signée** (`k: "lumen"`) et **le rôle** de qui l'a demandé (`r: "admin"`, seul rôle à qui Lumen serveur
//   est ouvert) : le proxy laisse passer un laissez-passer *avant* de regarder le rôle (`ADMIN_ONLY_READS` ne le
//   couvre donc pas), la route revérifie tout ;
// - **la lecture** (`s`, l'identifiant de l'adresse) : un jeton d'une lecture n'ouvre pas l'adresse d'une autre.
// Lecture seule (GET), et seulement sous `/api/lumen/{itemId}/{version}/{s}/tv.{jeton}/…` : `eligibility`, `prepare`,
// `pistes` et le reste de l'application exigent toujours une session.
//
// Le jeton finit dans les journaux d'accès du relais inverse, comme `castToken` : c'est pour cela qu'il meurt avec la
// session qui l'a demandé (déconnexion, session fermée par l'administrateur) et qu'il ne vaut que pour un titre.

import { config } from "@/lib/config";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { sessionDb } from "@/lib/db";

/** Six heures : un film et ses pauses (la règle de `castToken`). Au-delà, la page en redemande un (`recover`). */
export const LUMEN_TV_LIFETIME_MS = 6 * 60 * 60 * 1000;
/** Le préfixe du segment de chemin qui porte le jeton : `tv.{jeton}`. */
export const LUMEN_TV_PREFIX = "tv.";

/**
 * La portée signée : `lumen` pour une Apple TV (AirPlay, `tv.{jeton}`), `lumen-cc` pour un récepteur Chromecast
 * (`cc.{jeton}`, DECISIONS.md §192). Un jeton d'une portée n'ouvre jamais l'adresse de l'autre : l'adresse Chromecast
 * sert une autre liste maître (son AAC, `castView`) et répond en CORS, ce qu'une Apple TV n'a pas à recevoir.
 */
type LumenPassScope = "lumen" | "lumen-cc";

interface LumenTvClaims {
  /** La portée : `lumen` ou `lumen-cc`, et rien d'autre. */
  k: LumenPassScope;
  /** Le titre. */
  i: string;
  /** La lecture (`s` de l'adresse). */
  s: string;
  /** Qui l'a demandé, et son rôle à ce moment. */
  u: string;
  r: string;
  /** La session qui l'a demandé : le jeton meurt avec elle. */
  t: string;
  /** L'identifiant Jellyfin du compte : la position déduite des segments lui est rapportée (`castProgress.ts`). */
  j?: string;
  /** Fin de validité, en ms. */
  e: number;
}

/** Ce qu'un laissez-passer valable dit de qui l'a demandé. */
export interface LumenTvPass {
  user: string;
  role: "admin";
  jti: string;
  jfId: string | null;
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = "";
  for (const byte of view) str += String.fromCharCode(byte);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const str = atob(padded);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

async function getKey(): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`lumen-tv:${config.app.sessionSecret}`));
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

type PassSession = { u: string; role: string; jti?: string | null; jfId?: string | null };

/** Le jeton d'une lecture de ce titre pour cette session ; `null` pour tout autre rôle qu'administrateur. */
export async function signLumenTvPass(itemId: string, s: string, session: PassSession, now = Date.now()): Promise<string | null> {
  return signScoped("lumen", itemId, s, session, now);
}

async function signScoped(scope: LumenPassScope, itemId: string, s: string, session: PassSession, now: number): Promise<string | null> {
  // Un lien de partage, un compte ordinaire, une session sans identifiant : pas de laissez-passer — Lumen serveur ne
  // leur est pas ouvert, et un jeton qu'aucune session ne tient ne pourrait pas mourir avec elle.
  if (session.role !== "admin" || !session.jti) return null;
  const claims: LumenTvClaims = { k: scope, i: itemId, s, u: session.u, r: session.role, t: session.jti, ...(session.jfId ? { j: session.jfId } : {}), e: now + LUMEN_TV_LIFETIME_MS };
  const payload = base64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = base64url(await crypto.subtle.sign("HMAC", await getKey(), new TextEncoder().encode(payload)));
  return `${payload}.${signature}`;
}

/**
 * Le jeton ouvre-t-il **cette** lecture de **ce** titre, maintenant ? Le compte, ou `null` — jamais d'exception :
 * appelé par le proxy sur le chemin de chaque segment, une vérification qui lève deviendrait une panne.
 */
export async function verifyLumenTvPass(
  token: string | null | undefined,
  itemId: string,
  s: string,
  now = Date.now(),
  sessionAlive: (jti: string) => boolean = (jti) => sessionDb.exists(jti)
): Promise<LumenTvPass | null> {
  return verifyScoped("lumen", token, itemId, s, now, sessionAlive);
}

async function verifyScoped(
  scope: LumenPassScope,
  token: string | null | undefined,
  itemId: string,
  s: string,
  now: number,
  sessionAlive: (jti: string) => boolean
): Promise<LumenTvPass | null> {
  if (!token || token.length > 2048) return null;
  try {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) return null;
    const expected = new Uint8Array(await crypto.subtle.sign("HMAC", await getKey(), new TextEncoder().encode(payload)));
    const given = fromBase64url(signature);
    if (given.length !== expected.length) return null;
    // À temps constant (la règle de `castToken`).
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ given[i];
    if (diff !== 0) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as Partial<LumenTvClaims>;
    if (claims.k !== scope) return null;
    if (typeof claims.i !== "string" || claims.i !== itemId) return null;
    if (typeof claims.s !== "string" || claims.s !== s) return null;
    if (typeof claims.e !== "number" || claims.e <= now) return null;
    if (typeof claims.u !== "string" || !claims.u) return null;
    if (claims.r !== "admin") return null;
    if (typeof claims.t !== "string" || !claims.t || !sessionAlive(claims.t)) return null;
    return { user: claims.u, role: "admin", jti: claims.t, jfId: typeof claims.j === "string" && claims.j ? claims.j : null };
  } catch {
    return null;
  }
}

/** Ce qu'une adresse de Lumen serveur porte : titre, version, lecture, jeton éventuel, et le nom qui suit. */
export interface LumenTvAddress {
  itemId: string;
  version: string;
  s: string;
  token: string;
  rest: string[];
}

/**
 * `/api/lumen/{itemId}/{version}/{s}/tv.{jeton}/{nom…}` → ses parties ; `null` pour toute autre forme. Stricte : le
 * jeton est exactement le quatrième segment après `/api/lumen/`, et il faut un nom derrière.
 */
export function lumenTvAddressOf(pathname: string): LumenTvAddress | null {
  const m = /^\/api\/lumen\/([^/]+)\/([^/]+)\/([^/]+)\/tv\.([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\/(.+)$/.exec(pathname);
  if (!m || !isJellyfinId(m[1])) return null;
  const rest = m[5].split("/");
  if (rest.some((part) => !part || part === "." || part === "..")) return null;
  return { itemId: m[1], version: m[2], s: m[3], token: m[4], rest };
}

/**
 * La requête est-elle celle d'un téléviseur muni d'un laissez-passer Lumen valable ? Posée par le proxy (avant la
 * session, comme `castPassFor`) et revérifiée par la route avec la même fonction. GET seulement.
 */
export async function lumenTvPassFor(req: { method: string; nextUrl: { pathname: string } }): Promise<LumenTvPass | null> {
  if (req.method !== "GET") return null;
  const address = lumenTvAddressOf(req.nextUrl.pathname);
  if (!address) return null;
  return verifyLumenTvPass(address.token, address.itemId, address.s);
}

/** L'adresse de la liste maître munie du jeton : `…/{s}/tv.{jeton}/master.m3u8?audio=N`. */
export function withLumenTvPass(master: string, token: string): string {
  return master.replace(/\/master\.m3u8(\?|$)/, `/${LUMEN_TV_PREFIX}${token}/master.m3u8$1`);
}

// ── Le récepteur Chromecast (DECISIONS.md §192) ─────────────────────────────

/** Le préfixe du segment de chemin qui porte le jeton d'un récepteur Chromecast : `cc.{jeton}`. */
export const LUMEN_CC_PREFIX = "cc.";

/**
 * Le jeton d'un récepteur Chromecast pour une lecture de ce titre : les bornes du jeton d'une Apple TV (un titre, une
 * lecture, la session vivante, un administrateur, six heures, la même clé dérivée), sous la portée `lumen-cc`. Un
 * jeton AirPlay n'ouvre pas l'adresse Chromecast, ni l'inverse (`verifyScoped` compare la portée).
 */
export async function signLumenCastPass(itemId: string, s: string, session: PassSession, now = Date.now()): Promise<string | null> {
  return signScoped("lumen-cc", itemId, s, session, now);
}

export async function verifyLumenCastPass(
  token: string | null | undefined,
  itemId: string,
  s: string,
  now = Date.now(),
  sessionAlive: (jti: string) => boolean = (jti) => sessionDb.exists(jti)
): Promise<LumenTvPass | null> {
  return verifyScoped("lumen-cc", token, itemId, s, now, sessionAlive);
}

/** `/api/lumen/{itemId}/{version}/{s}/cc.{jeton}/{nom…}` → ses parties ; `null` pour toute autre forme (la règle de `tv.`). */
export function lumenCastAddressOf(pathname: string): LumenTvAddress | null {
  const m = /^\/api\/lumen\/([^/]+)\/([^/]+)\/([^/]+)\/cc\.([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\/(.+)$/.exec(pathname);
  if (!m || !isJellyfinId(m[1])) return null;
  const rest = m[5].split("/");
  if (rest.some((part) => !part || part === "." || part === "..")) return null;
  return { itemId: m[1], version: m[2], s: m[3], token: m[4], rest };
}

/** Un GET d'un récepteur muni d'un laissez-passer Chromecast valable — posé par le proxy, revérifié par la route. */
export async function lumenCastPassFor(req: { method: string; nextUrl: { pathname: string } }): Promise<LumenTvPass | null> {
  if (req.method !== "GET") return null;
  const address = lumenCastAddressOf(req.nextUrl.pathname);
  if (!address) return null;
  return verifyLumenCastPass(address.token, address.itemId, address.s);
}

/**
 * La question préalable (CORS) d'un récepteur sur la même adresse, avec le même jeton — la règle de `castPreflightFor`
 * (§64) : un `OPTIONS` n'emporte jamais de cookie, ne lit ni n'écrit rien ; la route y répond, jamais le proxy.
 */
export async function lumenCastPreflightFor(req: { method: string; nextUrl: { pathname: string } }): Promise<LumenTvPass | null> {
  if (req.method !== "OPTIONS") return null;
  const address = lumenCastAddressOf(req.nextUrl.pathname);
  if (!address) return null;
  return verifyLumenCastPass(address.token, address.itemId, address.s);
}

/** L'adresse de la liste maître munie du jeton d'un récepteur : `…/{s}/cc.{jeton}/master.m3u8?audio=N`. */
export function withLumenCastPass(master: string, token: string): string {
  return master.replace(/\/master\.m3u8(\?|$)/, `/${LUMEN_CC_PREFIX}${token}/master.m3u8$1`);
}

/** Pour les tests : signer des revendications quelconques avec la vraie clé (un jeton forgé de l'intérieur). */
export const __testing = {
  async signClaims(claims: Record<string, unknown>): Promise<string> {
    const payload = base64url(new TextEncoder().encode(JSON.stringify(claims)));
    const signature = base64url(await crypto.subtle.sign("HMAC", await getKey(), new TextEncoder().encode(payload)));
    return `${payload}.${signature}`;
  },
};
