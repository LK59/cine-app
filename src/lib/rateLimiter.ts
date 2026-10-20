import { NextResponse } from "next/server";

const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;

const attempts = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of attempts) {
    if (now > entry.resetAt) attempts.delete(ip);
  }
}, WINDOW_MS).unref?.();

/**
 * La clé d'une adresse (revue de sécurité du 20/10/2026) : une adresse IPv4 telle quelle, une IPv6
 * par son préfixe /64 — un abonné en reçoit un entier, et changer d'adresse à chaque essai y est
 * gratuit : compter l'adresse exacte ne freinait rien. Une IPv4 notée en IPv6 (`::ffff:1.2.3.4`)
 * redevient l'IPv4.
 */
export function rateKey(ip: string): string {
  const raw = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(raw);
  if (mapped) return mapped[1];
  if (!raw.includes(":")) return raw;
  const [head, tail = ""] = raw.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = raw.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => (g || "0").replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export function checkRateLimit(rawIp: string): boolean {
  const ip = rateKey(rawIp);
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (entry.count >= MAX_ATTEMPTS) return false;
  entry.count++;
  return true;
}

/**
 * Rendre la place qu'une connexion **réussie** avait prise (15/10/2026, passe de nuit, BUREAU-2).
 *
 * Le compteur prenait chaque tentative, réussites comprises : un foyer derrière une même box, dix
 * appareils connectés dans le quart d'heure, et la onzième connexion — avec le bon mot de passe —
 * répondait « Trop de tentatives ». Cette nuit-là, les agents de test l'ont épuisé en se connectant
 * correctement. Seuls les échecs comptent désormais.
 *
 * La place est toujours **prise avant** l'appel à Jellyfin et rendue après le succès, et non
 * comptée après l'échec : sinon une rafale de requêtes parallèles passerait toute la vérification
 * avant que le premier échec ne soit inscrit — c'est exactement ce que fait un bourrage
 * d'identifiants. Rendre sa seule place ne permet rien de plus : dix échecs par quart d'heure et
 * par adresse, quoi qu'on intercale de connexions réussies.
 */
export function refundRateLimit(rawIp: string): void {
  const entry = attempts.get(rateKey(rawIp));
  if (entry && entry.count > 0) entry.count--;
}

/** Les secondes qui restent avant que l'adresse retrouve ses tentatives — le message le dit. */
export function rateLimitRetryAfterSeconds(rawIp: string): number {
  const entry = attempts.get(rateKey(rawIp));
  if (!entry) return 0;
  return Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000));
}

/**
 * Le refus des écrans de connexion : un code et le vrai temps restant (BUREAU-2). Le message en
 * dur, en français, annonçait « 15 minutes » quelle que soit la langue — l'écran de connexion est
 * atteint avant toute préférence — et même quand il ne restait qu'une minute. Le message reste
 * rempli pour qui ne lirait pas le code (DECISIONS.md §80).
 */
export function rateLimitedResponse(ip: string): NextResponse {
  const retryAfterS = rateLimitRetryAfterSeconds(ip);
  return NextResponse.json(
    { error: "Trop de tentatives, réessayez plus tard", code: "rate_limited", retryAfterS },
    { status: 429, headers: { "Retry-After": String(retryAfterS) } }
  );
}

/**
 * Par compte, en plus de l'adresse (revue de sécurité du 20/10/2026) : vingt échecs par heure pour un
 * même nom, d'où qu'ils viennent. Des adresses tournantes passaient le freinage par adresse sans
 * limite, contre l'administrateur local (chaque essai tient le serveur ~50 ms de scrypt) ou contre un
 * compte Jellyfin, que son propre verrouillage aurait fini par bloquer. Comme pour l'adresse, la
 * place est prise avant l'essai et rendue au succès.
 */
const ACCOUNT_WINDOW_MS = 60 * 60_000;
const ACCOUNT_MAX_FAILURES = 20;
const accountAttempts = new Map<string, { count: number; resetAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [name, entry] of accountAttempts) if (now > entry.resetAt) accountAttempts.delete(name);
}, ACCOUNT_WINDOW_MS).unref?.();

export function checkAccountRateLimit(name: string, now = Date.now()): boolean {
  const key = name.trim().toLowerCase();
  if (!key) return true;
  const entry = accountAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    accountAttempts.set(key, { count: 1, resetAt: now + ACCOUNT_WINDOW_MS });
    return true;
  }
  if (entry.count >= ACCOUNT_MAX_FAILURES) return false;
  entry.count++;
  return true;
}

/** Le refus d'un compte trop essayé : la même forme que celui d'une adresse. */
export function accountRateLimitedResponse(name: string, now = Date.now()): NextResponse {
  const entry = accountAttempts.get(name.trim().toLowerCase());
  const retryAfterS = entry ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) : 60;
  return NextResponse.json(
    { error: "Trop de tentatives, réessayez plus tard", code: "rate_limited", retryAfterS },
    { status: 429, headers: { "Retry-After": String(retryAfterS) } }
  );
}

export function refundAccountRateLimit(name: string): void {
  const entry = accountAttempts.get(name.trim().toLowerCase());
  if (entry && entry.count > 0) entry.count--;
}

export function createRateLimiter(max: number, windowMs: number) {
  const store = new Map<string, { count: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.resetAt) store.delete(key);
    }
  }, windowMs).unref?.();

  return function (key: string): boolean {
    const now = Date.now();
    const entry = store.get(key);
    if (!entry || now > entry.resetAt) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (entry.count >= max) return false;
    entry.count++;
    return true;
  };
}
