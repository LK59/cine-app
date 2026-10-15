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

export function checkRateLimit(ip: string): boolean {
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
export function refundRateLimit(ip: string): void {
  const entry = attempts.get(ip);
  if (entry && entry.count > 0) entry.count--;
}

/** Les secondes qui restent avant que l'adresse retrouve ses tentatives — le message le dit. */
export function rateLimitRetryAfterSeconds(ip: string): number {
  const entry = attempts.get(ip);
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
