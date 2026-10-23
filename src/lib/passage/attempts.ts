import { rateKey } from "@/lib/rateLimiter";

/**
 * Le frein des essais ratés à l'entrée du passage (`/api/passage/redeem`, DECISIONS.md §119), route
 * publique.
 *
 * Seuls les **échecs** comptent : une personne qui recopie bien son code ne se bloque pas elle-même.
 * Par adresse cliente (`getClientIp`, qui ne croit `X-Forwarded-For` que d'un relais de confiance) :
 * cinq échecs en quinze minutes, et le sixième essai est refusé avant d'être regardé. Une IPv6 compte
 * par son préfixe /48 et non son /64 : un abonné peut recevoir un /48 entier, soit 65 536 /64 — autant
 * d'adresses neuves pour un seul attaquant (relecture de sécurité du 23/10/2026).
 *
 * Et pour toute l'installation, sur les codes seulement : 2 000 échecs en quinze minutes. Ce plafond
 * est aussi une porte qu'un anonyme peut fermer au foyer entier en l'atteignant exprès ; à cent, un
 * script modeste bloquait l'entrée par code en permanence. Relevé, il reste sans espoir pour qui
 * cherche un code :
 *   - un code a 32⁸ = 2⁴⁰ ≈ 1,1 × 10¹² valeurs (40 bits) ;
 *   - par fenêtre de 15 min, 2 000 essais touchent un code vivant avec une probabilité
 *     ≤ 2 000 × n / 2⁴⁰ ≈ 1,8 × 10⁻⁹ × n, n étant le nombre de codes vivants à cet instant (un ou
 *     deux au plus : un code vit quinze minutes et sert une fois) ;
 *   - même avec un code vivant en permanence, un an de saturation (35 040 fenêtres) donne
 *     35 040 × 2 000 / 2⁴⁰ ≈ 6,4 × 10⁻⁵.
 * Le jeton (256 bits) n'a pas besoin du plafond global ; il passe quand même par celui de l'adresse.
 *
 * L'état vit sur `globalThis` comme le cache du serveur : une copie du module par point d'entrée
 * compterait à part (CLAUDE.md, « The cache's state lives on globalThis »).
 */
export const PASSAGE_FAILURES_PER_ADDRESS = 5;
export const PASSAGE_CODE_FAILURES_GLOBAL = 2000;
export const PASSAGE_FAILURE_WINDOW_MS = 15 * 60_000;

interface Counter {
  count: number;
  resetAt: number;
}
interface State {
  byAddress: Map<string, Counter>;
  global: Counter;
}

const KEY = Symbol.for("cine-app.passageAttempts");
function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[KEY] ??= { byAddress: new Map(), global: { count: 0, resetAt: 0 } });
}

function live(c: Counter | undefined, now: number): number {
  return c && now < c.resetAt ? c.count : 0;
}

/** Ce client — ou l'installation entière pour un code — a-t-il épuisé ses essais ? */
export function passageBlocked(ip: string, kind: "token" | "code", now = Date.now()): boolean {
  const s = state();
  if (live(s.byAddress.get(rateKey(ip, 48)), now) >= PASSAGE_FAILURES_PER_ADDRESS) return true;
  return kind === "code" && live(s.global, now) >= PASSAGE_CODE_FAILURES_GLOBAL;
}

/** Un échec de plus. */
export function notePassageFailure(ip: string, kind: "token" | "code", now = Date.now()): void {
  const s = state();
  const key = rateKey(ip, 48);
  const entry = s.byAddress.get(key);
  if (!entry || now >= entry.resetAt) s.byAddress.set(key, { count: 1, resetAt: now + PASSAGE_FAILURE_WINDOW_MS });
  else entry.count += 1;
  if (kind === "code") {
    if (now >= s.global.resetAt) s.global = { count: 1, resetAt: now + PASSAGE_FAILURE_WINDOW_MS };
    else s.global.count += 1;
  }
  // Borné : une adresse expirée s'en va au passage d'une autre.
  if (s.byAddress.size > 5000) for (const [k, c] of s.byAddress) if (now >= c.resetAt) s.byAddress.delete(k);
}

/**
 * La durée minimale d'une réponse de l'entrée, réussie ou non : un refus « inconnu » ne doit pas se
 * distinguer d'un refus « déjà servi » ou « session fermée » par son temps (ce dernier lit la base et
 * déchiffre). Un objet et non une constante : les tests la ramènent à zéro, sauf celui qui la mesure.
 */
export const passageTiming = { floorMs: 400 };

/** Pour les tests. */
export function resetPassageAttempts(): void {
  const s = state();
  s.byAddress.clear();
  s.global = { count: 0, resetAt: 0 };
}
